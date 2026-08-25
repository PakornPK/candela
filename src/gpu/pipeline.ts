import unpackShader from '../shaders/unpack.wgsl?raw';
import demosaicShader from '../shaders/demosaic.wgsl?raw';
import adjustShader from '../shaders/adjust.wgsl?raw';
import blitShader from '../shaders/blit.wgsl?raw';
import { packAdjustUniforms, packCfa6, type AdjustState } from './uniforms';
import type { DecodedRaw } from '../raw/decode';

export class Pipeline {
  private bayerTexture: GPUTexture | null = null;
  private normalizedTexture: GPUTexture | null = null;
  private demosaicedTexture: GPUTexture | null = null;
  private adjustedTexture: GPUTexture | null = null;

  private readonly unpackPipeline: GPUComputePipeline;
  private readonly demosaicPipeline: GPUComputePipeline;
  private readonly adjustPipeline: GPUComputePipeline;
  private readonly blitPipeline: GPURenderPipeline;

  private readonly levelsBuffer: GPUBuffer;
  private readonly cfaBuffer: GPUBuffer;
  private readonly adjustUniformBuffer: GPUBuffer;
  private readonly blitSampler: GPUSampler;

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
    this.adjustPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: adjustShader }), entryPoint: 'main' },
    });
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

    this.levelsBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // 9 x vec4<u32> = 144 bytes -- the 6x6 CFA, one color per component
    // (packCfa6 emits 36 u32s filling all 144 bytes).
    this.cfaBuffer = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.adjustUniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blitSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
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
    this.adjustedTexture?.destroy();

    const size = [raw.width, raw.height];

    this.bayerTexture = this.device.createTexture({
      size,
      format: 'r16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.bayerTexture },
      raw.bayerData,
      { bytesPerRow: raw.width * 2 },
      { width: raw.width, height: raw.height },
    );

    this.normalizedTexture = this.device.createTexture({
      size,
      format: 'r32float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.demosaicedTexture = this.device.createTexture({
      size,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.adjustedTexture = this.device.createTexture({
      size,
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.device.queue.writeBuffer(this.levelsBuffer, 0, new Float32Array([raw.blackLevel, raw.whiteLevel, 0, 0]));
    this.device.queue.writeBuffer(this.cfaBuffer, 0, packCfa6(raw.cfa6));

    const encoder = this.device.createCommandEncoder();
    this.dispatchUnpack(encoder, raw.width, raw.height);
    this.dispatchDemosaic(encoder, raw.width, raw.height);
    this.device.queue.submit([encoder.finish()]);
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

  // Re-runs only adjust + blit — this is the < 50ms slider path (no re-demosaic).
  render(state: AdjustState): void {
    if (!this.demosaicedTexture || !this.adjustedTexture) return;
    this.device.queue.writeBuffer(this.adjustUniformBuffer, 0, packAdjustUniforms(state));

    const encoder = this.device.createCommandEncoder();
    const width = this.demosaicedTexture.width;
    const height = this.demosaicedTexture.height;

    const adjustBindGroup = this.device.createBindGroup({
      layout: this.adjustPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.demosaicedTexture.createView() },
        { binding: 1, resource: this.adjustedTexture.createView() },
        { binding: 2, resource: { buffer: this.adjustUniformBuffer } },
      ],
    });
    const adjustPass = encoder.beginComputePass();
    adjustPass.setPipeline(this.adjustPipeline);
    adjustPass.setBindGroup(0, adjustBindGroup);
    const [wx, wy] = this.workgroupCounts(width, height);
    adjustPass.dispatchWorkgroups(wx, wy);
    adjustPass.end();

    const blitBindGroup = this.device.createBindGroup({
      layout: this.blitPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.adjustedTexture.createView() },
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

    this.device.queue.submit([encoder.finish()]);
  }

  // Diagnostic: reads back an 8x8 block at the center of the adjusted
  // (blit-source) texture and reports its average and max RGB. If this comes
  // back non-black, the GPU compute chain is producing an image and any
  // black canvas is a surface/presentation problem; if it's black, the
  // compute chain itself is broken. Temporary, for the Develop-mode
  // black-image investigation.
  async diagnostic(): Promise<string> {
    if (!this.adjustedTexture) return 'adjustedTexture: none loaded';
    const { width, height } = this.adjustedTexture;
    const sample = 8;
    const bytesPerRow = 256; // copyTextureToBuffer requires 256 alignment
    const buffer = this.device.createBuffer({
      size: bytesPerRow * sample,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.adjustedTexture, origin: [Math.floor(width / 2), Math.floor(height / 2)] },
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
    return `adjustedTexture center ${sample}x${sample} of ${width}x${height}: avg rgb=(${(r / n).toFixed(4)}, ${(g / n).toFixed(4)}, ${(b / n).toFixed(4)}) max=${max.toFixed(4)}`;
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
    this.adjustedTexture?.destroy();
  }
}
