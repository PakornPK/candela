import unpackShader from '../shaders/unpack.wgsl?raw';
import demosaicShader from '../shaders/demosaic.wgsl?raw';
import blitShader from '../shaders/blit.wgsl?raw';
import { packCfa6, shiftCfa6 } from './uniforms';
import { OP_RENDERERS, presentOpIndices, setAsShotGains, setCameraColorMatrix, setCameraXyz } from './ops';
import type { Op } from '../catalog/types';
import type { DecodedRaw } from '../raw/decode';

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

  private readonly levelsBuffer: GPUBuffer;
  private readonly cfaBuffer: GPUBuffer;
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

  private constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
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

    this.levelsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // 9 x vec4<u32> = 144 bytes -- the 6x6 CFA, one color per component
    // (packCfa6 emits 36 u32s filling all 144 bytes).
    this.cfaBuffer = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    return new Pipeline(device, context, format);
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
      const bindGroup = this.device.createBindGroup({
        layout: this.opPipelines[index].getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: source.createView() },
          { binding: 1, resource: target.createView() },
          { binding: 2, resource: { buffer: this.opUniformBuffers[index] } },
        ],
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
      const histogramBindGroup = this.device.createBindGroup({
        layout: this.exportBlitPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.displayTexture.createView() },
          { binding: 1, resource: this.histogramSampler },
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

  // Renders the current ops to an offscreen srgb8 texture (same blit shader,
  // same OETF) and returns it as a JPEG/PNG Blob. The readback is the one
  // allowed GPU->CPU path. `maxDim` caps the long edge so a 60MP raw doesn't
  // OOM on a single ~240MB readback (6000 keeps it ~96MB); native-resolution
  // export would need tiled readback -- deferred.
  async exportImage(ops: Op[], format: 'jpeg' | 'png', maxDim = 6000): Promise<Blob> {
    if (!this.demosaicedTexture || !this.opA || !this.opB) {
      throw new Error('No image loaded to export.');
    }
    const srcW = this.demosaicedTexture.width;
    const srcH = this.demosaicedTexture.height;
    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const tw = Math.max(1, Math.round(srcW * scale));
    const th = Math.max(1, Math.round(srcH * scale));

    const encoder = this.device.createCommandEncoder();
    const source = this.dispatchOps(encoder, ops);
    this.displayTexture = source;

    const target = this.device.createTexture({
      size: [tw, th],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const blitBindGroup = this.device.createBindGroup({
      layout: this.exportBlitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: source.createView() },
        { binding: 1, resource: this.blitSampler },
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
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise<Blob>((resolve, reject) =>
      scratch.toBlob(
        (b) => (b ? resolve(b) : reject(new Error(`toBlob(${mime}) returned null`))),
        mime,
        format === 'jpeg' ? 0.92 : undefined,
      ),
    );
    target.destroy();
    readBuffer.destroy();
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
  }
}
