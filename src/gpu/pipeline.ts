import unpackShader from '../shaders/unpack.wgsl?raw';
import demosaicShader from '../shaders/demosaic.wgsl?raw';
import blitShader from '../shaders/blit.wgsl?raw';
import export16Shader from '../shaders/export16.wgsl?raw';
import downscaleShader from '../shaders/downscale.wgsl?raw';
import { packCfa6, shiftCfa6 } from './uniforms';
import { OP_RENDERERS, presentOpIndices, setAsShotGains, setCameraColorMatrix, setCameraXyz, setImageSize } from './ops';
import { cropFracFromOps } from './crop';
import { maskDims } from './dodge';
import { encodePng16, encodeTiff16 } from './exportEncode';
import type { Op } from '../catalog/types';
import type { DecodedRaw } from '../raw/decode';

export interface ExportOptions {
  format: 'jpeg' | 'png' | 'tiff';
  bitDepth: 8 | 16; // JPEG is 8-bit only; the caller disables 16 for it.
  longEdge: number | null; // null = original resolution.
}

export class Pipeline {
  private bayerTexture: GPUTexture | null = null;
  private normalizedTexture: GPUTexture | null = null;
  private demosaicedTexture: GPUTexture | null = null;
  // Ping-pong pair the per-op passes write/read against. displayTexture is
  // the blit source after render(): the last op's output, or the demosaiced
  // texture when no op is present.
  private opA: GPUTexture | null = null;
  private opB: GPUTexture | null = null;
  private displayTexture: GPUTexture | null = null;

  private readonly unpackPipeline: GPUComputePipeline;
  private readonly demosaicPipeline: GPUComputePipeline;
  private readonly blitPipeline: GPURenderPipeline;
  // Export blit: same blit.wgsl (OETF included) but targeting an offscreen
  // rgba8unorm texture instead of the canvas's drawing buffer -- render
  // target format is fixed at pipeline creation, so it can't share the canvas
  // pipeline.
  private readonly exportBlitPipeline: GPURenderPipeline;
  // 16-bit export readback (export16.wgsl): linear displayTexture -> sRGB
  // OETF'd rgba16uint storage texture. The 8-bit path uses exportBlitPipeline
  // + canvas; 16-bit needs a u16 source the canvas can't produce.
  private readonly export16Pipeline: GPUComputePipeline;
  // 2x2 box-average halving for export downscale (case #5): exportImage
  // pyramids with this until within 2x of the export size so a 60MP->1080
  // export never does one giant bilinear leap.
  private readonly downscalePipeline: GPUComputePipeline;

  private readonly levelsBuffer: GPUBuffer;
  private readonly cfaBuffer: GPUBuffer;
  // Blit uniforms (blit.wgsl binding 2): the crop mask fraction the blit
  // samples. The canvas always shows the full texture (window view = crop +
  // bars) so its buffer holds (1,1) forever; the histogram/export blits use a
  // SEPARATE buffer written per-use with the real fraction. Two buffers --
  // device.queue.writeBuffer for the crop one can't clobber the canvas one
  // (they'd both be wrong if shared, since queue writes land before any
  // encoder in the submit executes).
  private readonly canvasBlitUniform: GPUBuffer;
  private readonly cropBlitUniform: GPUBuffer;
  // One pipeline + uniform buffer per op kind, in OP_RENDERERS order. Index 0
  // is the `profile` op (camera color matrix) -- it subsumed the load-time
  // matrix pass, so there is no separate colorMatrixBuffer/cameraColorPipeline.
  private readonly opPipelines: GPUComputePipeline[];
  private readonly opUniformBuffers: GPUBuffer[];
  private readonly blitSampler: GPUSampler;
  // Histogram: displayTexture is blitted into a small rgba8unorm texture via a
  // NEAREST sampler, then copied back. Nearest (not bilinear) means each of the
  // 512x256 output texels samples one point of the full-res image -- a
  // stratified sample whose histogram matches the real distribution, where
  // bilinear averaging would bias toward mid-tones. Readback is gated to one
  // in flight so the slider hot path never stacks pending mapAsync calls.
  private readonly histogramTexture: GPUTexture;
  private readonly histogramSampler: GPUSampler;
  private readonly histogramReadBuffer: GPUBuffer;
  private histogramInFlight = false;
  private histogramListener: ((data: Uint8Array) => void) | null = null;

  // Dodge & Burn brush mask: a capped-resolution r8unorm texture (128 =
  // neutral) sampled by dodge.wgsl at the output's fractional uv. The mask is
  // display-space and dims are proportional to the loaded image (see dodge.ts
  // maskDims), so the same uv lands on the same content in both textures.
  // Uploaded via setDodgeMask whenever the CPU-side paint mask changes (the
  // single GPU->CPU readback rule: the mask is CPU-authoritative, GPU is a
  // render-only copy).
  private dodgeMaskTexture: GPUTexture | null = null;
  private readonly dodgeMaskSampler: GPUSampler;

  // Vendored 35mm film-strip edge texture (case #4): the '135' frame band
  // samples it instead of procedural sprocket rects. Loaded in Pipeline.create
  // (async fetch of public/frames/135-strip.png, committed into the repo -- no
  // runtime network for user data). rgba8unorm-srgb so sampling auto-decodes
  // sRGB -> linear, matching the old procedural colors.
  private readonly filmStripTexture: GPUTexture;
  private readonly filmStripSampler: GPUSampler;
  private readonly leakTextures: GPUTexture[];
  private readonly leakSampler: GPUSampler;

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    filmStripTexture: GPUTexture,
    leakTextures: GPUTexture[],
  ) {
    this.unpackPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: unpackShader }), entryPoint: 'main' },
    });
    this.demosaicPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: demosaicShader }), entryPoint: 'main' },
    });
    this.opPipelines = OP_RENDERERS.map((r) => device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: r.shader }), entryPoint: 'main' },
    }));
    this.blitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code: blitShader }), entryPoint: 'vs_main' },
      fragment: {
        module: device.createShaderModule({ code: blitShader }),
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.exportBlitPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: device.createShaderModule({ code: blitShader }), entryPoint: 'vs_main' },
      fragment: {
        module: device.createShaderModule({ code: blitShader }),
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba8unorm' }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.export16Pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: export16Shader }), entryPoint: 'main' },
    });
    this.downscalePipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: downscaleShader }), entryPoint: 'main' },
    });

    this.levelsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // 9 x vec4<u32> = 144 bytes -- the 6x6 CFA, one color per component
    // (packCfa6 emits 36 u32s filling all 144 bytes).
    this.cfaBuffer = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.canvasBlitUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cropBlitUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.canvasBlitUniform, 0, new Float32Array([1, 1, 0, 0]));
    this.opUniformBuffers = OP_RENDERERS.map((r) => device.createBuffer({
      size: r.uniformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    this.blitSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    // 512x256 texels, 4 bytes each = 512 KB readback. bytesPerRow 2048 is
    // already 256-aligned, so no row padding on the copy.
    this.histogramTexture = device.createTexture({
      size: [512, 256],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.histogramSampler = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    this.histogramReadBuffer = device.createBuffer({
      size: 512 * 256 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    this.dodgeMaskSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.filmStripTexture = filmStripTexture;
    this.filmStripSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.leakTextures = leakTextures;
    this.leakSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  static async create(canvas: HTMLCanvasElement): Promise<Pipeline> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not supported in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter available.');
    }
    // Default device limits cap maxTextureDimension2D far below what a 60MP
    // raw needs (e.g. ~9500x6300 for a 61MP sensor) — request the adapter's
    // actual max so texture creation in load() doesn't throw on real files.
    const device = await adapter.requestDevice({
      requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
    // Surface every GPU validation/runtime error to the console so a failed
    // render isn't a silent black canvas (see the Develop-mode black-image
    // investigation).
    device.addEventListener('uncapturederror', (e) => {
      console.error('[gpu] uncaptured error:', e.error.message);
    });
    const context = canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Failed to get a WebGPU canvas context.');
    }
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    const [filmStrip, leaks] = await Promise.all([loadFilmStrip(device), loadLightLeaks(device)]);
    return new Pipeline(device, context, format, filmStrip, leaks);
  }

  // (Re)creates the canvas surface. The develop module hides its canvas
  // (display:none) while Library is active, and a WebGPU surface acquired on
  // a hidden / zero-layout canvas can stay stale or 1x1 when it becomes
  // visible again. Re-configuring on show forces a fresh drawing buffer at
  // the canvas's current width/height.
  show(): void {
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
  }

  // Destroys prior textures before uploading the new file's data — this is
  // what keeps GPU memory stable across repeated file loads.
  load(raw: DecodedRaw): void {
    this.bayerTexture?.destroy();
    this.normalizedTexture?.destroy();
    this.demosaicedTexture?.destroy();
    this.opA?.destroy();
    this.opB?.destroy();
    this.dodgeMaskTexture?.destroy();
    this.dodgeMaskTexture = null;
    this.displayTexture = null;

    // Crop the raw buffer to the effective (sensor-cropped) image area. LibRaw's
    // raw_width/raw_height include sensor margins (Fuji X100V: 6384x4182 buffer,
    // 6240x4160 real); rendering the full buffer shows the unused margin as a
    // dark column -- the tone's black-floor lift turns the zeros into a visible
    // near-black bar down the right edge. The crop happens at the bayer upload:
    // the texture IS the effective area, so every downstream pass, the histogram
    // and the canvas blit are auto-cropped. No shader changes.
    const effW = raw.effectiveWidth ?? raw.width;
    const effH = raw.effectiveHeight ?? raw.height;
    const cropLeft = raw.leftMargin ?? 0;
    const cropTop = raw.topMargin ?? 0;
    const size = [effW, effH];

    this.bayerTexture = this.device.createTexture({
      size,
      format: 'r16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Sub-rect copy: the row stride is the FULL raw row width and the data
    // starts at the crop origin, so only the effective area lands in the
    // texture (writeTexture reads rows bytesPerRow apart from byte 0 of data).
    this.device.queue.writeTexture(
      { texture: this.bayerTexture },
      raw.bayerData.subarray(cropTop * raw.width + cropLeft),
      { bytesPerRow: raw.width * 2 },
      { width: effW, height: effH },
    );

    this.normalizedTexture = this.device.createTexture({
      size,
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    // Demosaiced camera-RGB. The `profile` op (registry index 0) applies the
    // camera color matrix on top of this -- there is no pre-matrixed base
    // anymore, so the op chain always starts from the raw sensor data and the
    // matrix is one more (history-aware) op instead of a load-time constant.
    this.demosaicedTexture = this.device.createTexture({
      size,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const workUsage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;
    this.opA = this.device.createTexture({ size, format: 'rgba16float', usage: workUsage });
    this.opB = this.device.createTexture({ size, format: 'rgba16float', usage: workUsage });

    // The dodge/burn mask texture is created (empty) per file so its dims track
    // the loaded image; main.ts uploads the painted bytes via setDodgeMask.
    // The neutral fill is 128 (density 0) -- byte 0 would sample to density -1
    // (full burn).
    const [maskW, maskH] = maskDims(effW, effH);
    this.dodgeMaskTexture = this.device.createTexture({
      size: [maskW, maskH],
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.setDodgeMask(new Uint8Array(maskW * maskH).fill(128));

    this.device.queue.writeBuffer(this.levelsBuffer, 0, new Float32Array([raw.blackLevel, raw.whiteLevel, 0, 0]));
    this.device.queue.writeBuffer(this.cfaBuffer, 0, packCfa6(shiftCfa6(raw.cfa6, cropLeft, cropTop)));
    // Always a valid 3x3 (decode.ts fills identity when the camera has no
    // matrix). The profile op's packParams reads this via setCameraColorMatrix.
    setCameraColorMatrix(raw.colorMatrix);
    // cam_xyz (XYZ->camera) for the WB temp/tint readout; undefined when the
    // camera has no usable matrix (the readout then falls back to the legacy
    // axes).
    setCameraXyz(raw.camXyz);
    // As-Shot WB default (identity when the camera reports no cam_mul). The
    // whiteBalance op's packParams reads this when no WB op is present.
    setAsShotGains(raw.asShotGains ?? { r: 1, g: 1, b: 1 });
    // The crop op's geometry, and the vignette/frame cropFrac it feeds, are
    // fractions of the effective size -- module-level in ops.ts so packParams
    // can resolve them from the current image.
    setImageSize(effW, effH);

    const encoder = this.device.createCommandEncoder();
    this.dispatchUnpack(encoder, effW, effH);
    this.dispatchDemosaic(encoder, effW, effH);
    this.device.queue.submit([encoder.finish()]);

    // Before the first render() the blit source is the raw demosaiced data
    // (render() replaces it with the profile-op output).
    this.displayTexture = this.demosaicedTexture;
  }

  private workgroupCounts(width: number, height: number): [number, number] {
    return [Math.ceil(width / 8), Math.ceil(height / 8)];
  }

  private dispatchUnpack(encoder: GPUCommandEncoder, width: number, height: number): void {
    const bindGroup = this.device.createBindGroup({
      layout: this.unpackPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.bayerTexture!.createView() },
        { binding: 1, resource: this.normalizedTexture!.createView() },
        { binding: 2, resource: { buffer: this.levelsBuffer } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.unpackPipeline);
    pass.setBindGroup(0, bindGroup);
    const [wx, wy] = this.workgroupCounts(width, height);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
  }

  private dispatchDemosaic(encoder: GPUCommandEncoder, width: number, height: number): void {
    const bindGroup = this.device.createBindGroup({
      layout: this.demosaicPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.normalizedTexture!.createView() },
        { binding: 1, resource: this.demosaicedTexture!.createView() },
        { binding: 2, resource: { buffer: this.cfaBuffer } },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.demosaicPipeline);
    pass.setBindGroup(0, bindGroup);
    const [wx, wy] = this.workgroupCounts(width, height);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
  }

  // Runs every present op against the ping-pong pair and returns the last
  // op's output. presentOpIndices always includes the first two passes
  // (whiteBalance As-Shot fallback + profile camera matrix), so even a no-ops
  // fresh open (renderOps([])) applies both -- the chain always starts from
  // demosaicedTexture. Shared by render() (canvas blit source) and
  // exportImage() (offscreen target) so both produce exactly the same picture
  // from the same ops.
  private dispatchOps(encoder: GPUCommandEncoder, ops: Op[]): GPUTexture {
    const width = this.demosaicedTexture!.width;
    const height = this.demosaicedTexture!.height;
    let source = this.demosaicedTexture!;
    const present = presentOpIndices(ops);
    for (let i = 0; i < present.length; i++) {
      const index = present[i];
      const target = i % 2 === 0 ? this.opA! : this.opB!;
      const renderer = OP_RENDERERS[index];
      this.device.queue.writeBuffer(this.opUniformBuffers[index], 0, renderer.packParams(ops));
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: target.createView() },
        { binding: 2, resource: { buffer: this.opUniformBuffers[index] } },
      ];
      // Dodge & Burn carries two extra bindings: the painted mask texture and
      // its linear sampler (dodge.wgsl binding 3/4).
      if (renderer.kind === 'dodgeBurn') {
        entries.push(
          { binding: 3, resource: this.dodgeMaskTexture!.createView() },
          { binding: 4, resource: this.dodgeMaskSampler },
        );
      }
      // Frame carries the same two extra slots: the vendored film-strip edge
      // texture + linear sampler (frame.wgsl binding 3/4). Bound for every
      // frame style -- the shader only samples it for '135'.
      if (renderer.kind === 'frame') {
        entries.push(
          { binding: 3, resource: this.filmStripTexture.createView() },
          { binding: 4, resource: this.filmStripSampler },
        );
      }
      // Light leak carries four: the three vendored leak textures + one shared
      // linear sampler (lightleak.wgsl binding 3/4/5/6).
      if (renderer.kind === 'lightleak') {
        entries.push(
          { binding: 3, resource: this.leakTextures[0].createView() },
          { binding: 4, resource: this.leakTextures[1].createView() },
          { binding: 5, resource: this.leakTextures[2].createView() },
          { binding: 6, resource: this.leakSampler },
        );
      }
      const bindGroup = this.device.createBindGroup({
        layout: this.opPipelines[index].getBindGroupLayout(0),
        entries,
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.opPipelines[index]);
      pass.setBindGroup(0, bindGroup);
      const [wx, wy] = this.workgroupCounts(width, height);
      pass.dispatchWorkgroups(wx, wy);
      pass.end();
      source = target;
    }
    return source;
  }

  // Re-runs only the present ops + blit — this is the < 50ms slider path (no
  // re-demosaic). Ops dispatch in registry order via dispatchOps.
  render(ops: Op[]): void {
    if (!this.demosaicedTexture || !this.opA || !this.opB) return;

    const encoder = this.device.createCommandEncoder();
    this.displayTexture = this.dispatchOps(encoder, ops);

    const blitBindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.displayTexture.createView() },
        { binding: 1, resource: this.blitSampler },
        // canvasBlitUniform stays (1,1): the canvas is the window view, crop +
        // bars, never the cropped region alone.
        { binding: 2, resource: { buffer: this.canvasBlitUniform } },
      ],
    });
    // The blit target is the canvas's drawing buffer -- if it comes back
    // 1x1 or throws (hidden/stale surface), the canvas stays black no matter
    // how correct the compute output is. Log its size so the Develop-mode
    // black-image diagnosis can tell surface failures apart from compute
    // failures.
    let targetView: GPUTextureView;
    try {
      const target = this.context.getCurrentTexture();
      console.log(`[gpu] render blit target: ${target.width}x${target.height}`);
      targetView = target.createView();
    } catch (err) {
      console.error('[gpu] getCurrentTexture() threw:', err);
      throw err;
    }
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: targetView,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    renderPass.setPipeline(this.blitPipeline);
    renderPass.setBindGroup(0, blitBindGroup);
    renderPass.draw(3);
    renderPass.end();

    // Histogram capture piggybacks on this render's encoder (same display
    // output, no extra submit). Skipped while a readback is still in flight.
    const wantHistogram = this.histogramListener !== null && !this.histogramInFlight;
    if (wantHistogram) {
      this.histogramInFlight = true;
      // Sample only the image content, not the bars (the crop mask fraction).
      const cropFrac = cropFracFromOps(ops, this.demosaicedTexture!.width, this.demosaicedTexture!.height);
      this.device.queue.writeBuffer(this.cropBlitUniform, 0, new Float32Array([cropFrac[0], cropFrac[1], 0, 0]));
      const histogramBindGroup = this.device.createBindGroup({
        layout: this.exportBlitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.displayTexture.createView() },
          { binding: 1, resource: this.histogramSampler },
          { binding: 2, resource: { buffer: this.cropBlitUniform } },
        ],
      });
      const histogramPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: this.histogramTexture.createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
      histogramPass.setPipeline(this.exportBlitPipeline);
      histogramPass.setBindGroup(0, histogramBindGroup);
      histogramPass.draw(3);
      histogramPass.end();
      encoder.copyTextureToBuffer(
        { texture: this.histogramTexture },
        { buffer: this.histogramReadBuffer, bytesPerRow: 512 * 4 },
        { width: 512, height: 256 },
      );
    }

    this.device.queue.submit([encoder.finish()]);
    if (wantHistogram) void this.readHistogram();
  }

  // Uploads the dodge/burn brush mask (128-neutral display bytes, see
  // dodge.ts maskToBytes) into the GPU mask texture. Called by main.ts when
  // the CPU-side paint mask changes (each stroke + after a restore), before
  // the next render/export. writeTexture requires 256-aligned row strides, so
  // the unpadded bytes are copied into padded rows first.
  setDodgeMask(bytes: Uint8Array): void {
    if (!this.dodgeMaskTexture) return;
    const w = this.dodgeMaskTexture.width;
    const h = this.dodgeMaskTexture.height;
    if (bytes.length !== w * h) return;
    const bytesPerRow = Math.ceil(w / 256) * 256;
    const padded = bytesPerRow === w ? bytes : (() => {
      const out = new Uint8Array(bytesPerRow * h);
      for (let y = 0; y < h; y++) {
        out.set(bytes.subarray(y * w, y * w + w), y * bytesPerRow);
      }
      return out;
    })();
    this.device.queue.writeTexture(
      { texture: this.dodgeMaskTexture },
      padded,
      { bytesPerRow },
      { width: w, height: h },
    );
  }

  // Subscribes the caller to each completed histogram readback. A 512x256
  // rgba8unorm Uint8Array (0..255 per channel) is delivered -- sRGB-encoded
  // by blit.wgsl's OETF, i.e. display-referred like LrC's histogram.
  setHistogramListener(listener: ((data: Uint8Array) => void) | null): void {
    this.histogramListener = listener;
  }

  private async readHistogram(): Promise<void> {
    try {
      await this.histogramReadBuffer.mapAsync(GPUMapMode.READ);
      const data = new Uint8Array(this.histogramReadBuffer.getMappedRange());
      const copy = new Uint8Array(data);
      this.histogramReadBuffer.unmap();
      this.histogramListener?.(copy);
    } catch (err) {
      console.error('[gpu] histogram readback failed:', err);
    } finally {
      this.histogramInFlight = false;
    }
  }

  // Renders the current ops to an offscreen texture and returns it as a
  // JPEG/PNG/TIFF Blob. 8-bit stages through the canvas encoder (JPEG/PNG);
  // 16-bit (PNG/TIFF) reads back a true u16 source via export16.wgsl and
  // hand-encodes, since the canvas cannot produce 16-bit output. The readback
  // is the one allowed GPU->CPU path. `longEdge` caps the long edge so a 60MP
  // raw doesn't OOM on a single ~240MB readback; Original would need tiled
  // readback at that size -- the user's explicit choice.
  async exportImage(ops: Op[], opts: ExportOptions): Promise<Blob> {
    if (!this.demosaicedTexture || !this.opA || !this.opB) {
      throw new Error('No image loaded to export.');
    }
    const srcW = this.demosaicedTexture.width;
    const srcH = this.demosaicedTexture.height;
    // Export the crop mask region -- the WYSIWYG loupe view (rotated crop +
    // straighten wedges), bars excluded. No crop = the full source.
    const cropFrac = cropFracFromOps(ops, srcW, srcH);
    const maskW = srcW * cropFrac[0];
    const maskH = srcH * cropFrac[1];
    const scale = opts.longEdge === null ? 1 : Math.min(1, opts.longEdge / Math.max(maskW, maskH));
    const tw = Math.max(1, Math.round(maskW * scale));
    const th = Math.max(1, Math.round(maskH * scale));

    const encoder = this.device.createCommandEncoder();
    const source = this.dispatchOps(encoder, ops);
    this.displayTexture = source;
    this.device.queue.writeBuffer(this.cropBlitUniform, 0, new Float32Array([cropFrac[0], cropFrac[1], 0, 0]));

    // Box-filter pyramid (case #5): halve with exact 2x2 box-averages until the
    // remaining reduction is <= 2x, then the blit/export16 passes do that final
    // step. Every source texel contributes equally (area-average), where one
    // bilinear 8x leap smears fine detail and phase-shifts the mean. No halving
    // for longEdge null (scale 1) -- tw/th equal the source.
    const intermediates: GPUTexture[] = [];
    let downSrc = source;
    let dw = srcW, dh = srcH;
    while (Math.max(dw, dh) > Math.max(2, Math.max(tw, th) * 2)) {
      const nw = Math.max(1, Math.ceil(dw / 2));
      const nh = Math.max(1, Math.ceil(dh / 2));
      const t = this.device.createTexture({
        size: [nw, nh],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      const bg = this.device.createBindGroup({
        layout: this.downscalePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: downSrc.createView() },
          { binding: 1, resource: t.createView() },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.downscalePipeline);
      pass.setBindGroup(0, bg);
      pass.dispatchWorkgroups(Math.ceil(nw / 8), Math.ceil(nh / 8));
      pass.end();
      intermediates.push(t);
      downSrc = t;
      dw = nw; dh = nh;
    }

    // 16-bit path: compute pass applies the OETF and writes u16 to a storage
    // texture; the encoders wrap it into a real 16-bit PNG/TIFF.
    if (opts.bitDepth === 16 && opts.format !== 'jpeg') {
      const target = this.device.createTexture({
        size: [tw, th],
        format: 'rgba16uint',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      const bindGroup = this.device.createBindGroup({
        layout: this.export16Pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: downSrc.createView() },
          { binding: 1, resource: this.blitSampler },
          { binding: 2, resource: { buffer: this.cropBlitUniform } },
          { binding: 3, resource: target.createView() },
        ],
      });
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.export16Pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(tw / 8), Math.ceil(th / 8));
      pass.end();
      const bytesPerRow = Math.ceil((tw * 8) / 256) * 256; // 8 bytes/texel
      const readBuffer = this.device.createBuffer({
        size: bytesPerRow * th,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      encoder.copyTextureToBuffer(
        { texture: target },
        { buffer: readBuffer, bytesPerRow },
        { width: tw, height: th },
      );
      this.device.queue.submit([encoder.finish()]);
      await readBuffer.mapAsync(GPUMapMode.READ);
      const mapped = new Uint16Array(readBuffer.getMappedRange());
      // Rows are padded to bytesPerRow; unpack back to tight RGBA u16 rows.
      const out = new Uint16Array(tw * th * 4);
      for (let y = 0; y < th; y++) {
        const row = (y * bytesPerRow) / 2;
        out.set(mapped.subarray(row, row + tw * 4), y * tw * 4);
      }
      readBuffer.unmap();
      target.destroy();
      readBuffer.destroy();
      intermediates.forEach((t) => t.destroy());
      const bytes = opts.format === 'tiff' ? encodeTiff16(out, tw, th) : await encodePng16(out, tw, th);
      return new Blob([bytes], { type: opts.format === 'tiff' ? 'image/tiff' : 'image/png' });
    }

    // 8-bit path: rgba8unorm blit -> canvas -> the browser's JPEG/PNG encoder.
    const target = this.device.createTexture({
      size: [tw, th],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const blitBindGroup = this.device.createBindGroup({
      layout: this.exportBlitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: downSrc.createView() },
        { binding: 1, resource: this.blitSampler },
        { binding: 2, resource: { buffer: this.cropBlitUniform } },
      ],
    });
    const renderPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: target.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    renderPass.setPipeline(this.exportBlitPipeline);
    renderPass.setBindGroup(0, blitBindGroup);
    renderPass.draw(3);
    renderPass.end();

    // copyTextureToBuffer requires bytesPerRow to be a multiple of 256.
    const bytesPerRow = Math.ceil((tw * 4) / 256) * 256;
    const readBuffer = this.device.createBuffer({
      size: bytesPerRow * th,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyTextureToBuffer(
      { texture: target },
      { buffer: readBuffer, bytesPerRow },
      { width: tw, height: th },
    );
    this.device.queue.submit([encoder.finish()]);
    await readBuffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(readBuffer.getMappedRange());
    // Rows are padded to bytesPerRow; unpack back to tight rows.
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) {
      out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + tw * 4), y * tw * 4);
    }
    readBuffer.unmap();

    const scratch = document.createElement('canvas');
    scratch.width = tw;
    scratch.height = th;
    const ctx = scratch.getContext('2d');
    if (!ctx) throw new Error('No 2d context for the export staging canvas.');
    const image = ctx.createImageData(tw, th);
    image.data.set(out);
    ctx.putImageData(image, 0, 0);
    const mime = opts.format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob>((resolve, reject) =>
      scratch.toBlob(
        (b) => (b ? resolve(b) : reject(new Error(`toBlob(${mime}) returned null`))),
        mime,
        opts.format === 'jpeg' ? 0.92 : undefined,
      ),
    );
    target.destroy();
    readBuffer.destroy();
    intermediates.forEach((t) => t.destroy());
    return blob;
  }

  // Diagnostic: reads back an 8x8 block at the center of the current
  // blit-source texture and reports its average and max RGB. If this comes
  // back non-black, the GPU compute chain is producing an image and any
  // black canvas is a surface/presentation problem; if it's black, the
  // compute chain itself is broken. Temporary, for the Develop-mode
  // black-image investigation.
  async diagnostic(): Promise<string> {
    if (!this.displayTexture) return 'displayTexture: none loaded';
    const { width, height } = this.displayTexture;
    const sample = 8;
    const bytesPerRow = 256; // copyTextureToBuffer requires 256 alignment
    const buffer = this.device.createBuffer({
      size: bytesPerRow * sample,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.displayTexture, origin: [Math.floor(width / 2), Math.floor(height / 2)] },
      { buffer, bytesPerRow },
      { width: sample, height: sample },
    );
    this.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const floats = new Float32Array(buffer.getMappedRange());
    let r = 0, g = 0, b = 0, max = 0;
    for (let j = 0; j < sample; j++) {
      for (let i = 0; i < sample; i++) {
        // rgba16float = 8 bytes/texel; row stride = bytesPerRow.
        const o = (j * bytesPerRow) / 4 + i * 2;
        r += floats[o];
        g += floats[o + 1];
        b += floats[o + 2];
        max = Math.max(max, floats[o], floats[o + 1], floats[o + 2]);
      }
    }
    buffer.unmap();
    const n = sample * sample;
    return `displayTexture center ${sample}x${sample} of ${width}x${height}: avg rgb=(${(r / n).toFixed(4)}, ${(g / n).toFixed(4)}, ${(b / n).toFixed(4)}) max=${max.toFixed(4)}`;
  }

  // Resolves once GPU work submitted so far has actually finished executing,
  // not just been encoded/submitted -- queue.submit() itself returns as soon
  // as commands are enqueued. Needed for accurate perf timing (see main.ts):
  // without this, performance.now() around load()/render() measures
  // encode+submit time only, silently excluding real GPU execution time.
  async waitForGPU(): Promise<void> {
    await this.device.queue.onSubmittedWorkDone();
  }

  destroy(): void {
    this.bayerTexture?.destroy();
    this.normalizedTexture?.destroy();
    this.demosaicedTexture?.destroy();
    this.opA?.destroy();
    this.opB?.destroy();
    this.histogramTexture.destroy();
    this.histogramReadBuffer.destroy();
    this.canvasBlitUniform.destroy();
    this.cropBlitUniform.destroy();
    this.dodgeMaskTexture?.destroy();
    this.filmStripTexture.destroy();
    for (const t of this.leakTextures) t.destroy();
    // Samplers have no destroy() (device-lifetime objects) -- the texture owns
    // the memory.
  }
}

// Loads the vendored 35mm film-strip edge texture for the '135' frame style.
// Fetching the committed static asset is a build asset, not a runtime network
// call for user data (the vendoring rule). A 1x1 black fallback keeps the
// frame op valid if the asset is ever missing.
//
// ponytail: upload via writeTexture of the decoded RGBA bytes, NOT
// copyExternalImageToTexture -- in this headless-Chrome/WebGPU combo the
// external-image copy silently produced an all-zero texture (the frame band
// came out pure black). writeTexture is the deterministic path the rest of the
// app already uses.
async function loadFilmStrip(device: GPUDevice): Promise<GPUTexture> {
  return loadPngTexture(device, '/frames/135-strip.png', 'rgba8unorm-srgb', 'film strip');
}

// The three vendored light-leak textures. rgba8unorm (NOT -srgb): the bytes
// are linear additive values, so the shader adds `texture * gain` straight to
// linear RGB. A missing leak texture falls back to a 1x1 black texel, which
// samples as 0 -- the leak just adds nothing for that asset.
async function loadLightLeaks(device: GPUDevice): Promise<GPUTexture[]> {
  return Promise.all(['leak-0', 'leak-1', 'leak-2'].map((n) => loadPngTexture(device, `/leaks/${n}.png`, 'rgba8unorm', 'light leak')));
}

// Decode a committed PNG through a 2D canvas and upload via writeTexture --
// NOT copyExternalImageToTexture, which silently produced an all-zero texture
// in this headless-Chrome/WebGPU combo (the vendoring rule: these are build
// assets, not runtime network calls for user data). 1x1 black fallback keeps
// the op valid if an asset is ever missing.
async function loadPngTexture(device: GPUDevice, url: string, format: GPUTextureFormat, label: string): Promise<GPUTexture> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bitmap = await createImageBitmap(await res.blob());
    const c = document.createElement('canvas');
    c.width = bitmap.width;
    c.height = bitmap.height;
    const cx = c.getContext('2d');
    if (!cx) throw new Error(`no 2d context for ${label} decode`);
    cx.drawImage(bitmap, 0, 0);
    const pixels = cx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const tex = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: tex },
      pixels,
      { bytesPerRow: bitmap.width * 4 },
      [bitmap.width, bitmap.height],
    );
    return tex;
  } catch (err) {
    console.error(`[gpu] ${label} load failed, using 1x1 fallback:`, err);
    const tex = device.createTexture({
      size: [1, 1],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: tex }, new Uint8Array([0, 0, 0, 255]), {}, [1, 1]);
    return tex;
  }
}
