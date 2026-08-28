// Headless repro harness: decode sample.raf, run the real unpack + MHC
// demosaic on the GPU, read back the FULL demosaiced texture, localize the
// blown-out magenta region (R>=0.99, B>=0.90, G in [0.75,0.95] -- the area the
// user photographed), and measure G's 2D autocorrelation THERE. A coherent
// lattice is corr(lag4) HIGH and corr(lag1..3) LOW; a smooth gradient has
// corr(lag1) near 0.95 (monotone decay). No canvas/CSS/screenshot involved.
import { decode } from './src/raw/decode';
import unpackShader from './src/shaders/unpack.wgsl?raw';
import demosaicShader from './src/shaders/demosaic.wgsl?raw';
import { packCfa6, shiftCfa6 } from './src/gpu/uniforms';
import { buildToneLuts, LOG_MIN, LOG_MAX, logToNorm, sampleToneLut } from './src/gpu/tone';
import { effectiveMask, maskDims, maskToBytes, maskToOp, paintStroke } from './src/gpu/dodge';
import { setGrainSeed } from './src/gpu/grain';
import type { FileRecord } from './src/catalog/types';

const out = document.getElementById('out')!;
const log = (s: string) => { out.textContent += '\n' + s; console.log(s); };
// Tee the GPU device's uncaptured errors (pipeline has its own device + its
// own listener that console.errors) into #out so the driver sees them.
const _origErr = console.error.bind(console);
console.error = (msg, ...rest) => { out.textContent += '\n[console.error] ' + String(msg) + (rest.length ? ' ' + rest.join(' ') : ''); _origErr(msg, ...rest); };

// Half-float -> f32 via a 64K-entry LUT (Math.pow per channel for 104M
// channels was the harness bottleneck).
const HALF_LUT = new Float32Array(65536);
{
  let h = 0;
  while (h < 65536) {
    const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, f = h & 0x3ff;
    HALF_LUT[h] = e === 0
      ? (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024)
      : e === 31 ? (f ? NaN : (s ? -1 : 1) * Infinity)
      : (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
    h++;
  }
}
function dehalf(h: number): number { return HALF_LUT[h]; }

async function main() {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { log('NO GPU ADAPTER'); return; }
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => log('[gpu] ' + e.error.message));

  const resp = await fetch('/src/raw/__fixtures__/sample.raf');
  const bytes = await resp.arrayBuffer();
  log('fetched sample.raf ' + bytes.byteLength + ' bytes');

  const t0 = performance.now();
  const raw = await decode(bytes);
  log(`decoded ${raw.width}x${raw.height} eff ${raw.effectiveWidth}x${raw.effectiveHeight} in ${(performance.now() - t0).toFixed(0)}ms`);
  log('cfa6: ' + Array.from(raw.cfa6).join(','));

  const effW = raw.effectiveWidth ?? raw.width;
  const effH = raw.effectiveHeight ?? raw.height;
  const cropLeft = raw.leftMargin ?? 0;
  const cropTop = raw.topMargin ?? 0;
  const size = [effW, effH];

  const bayer = device.createTexture({ size, format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture(
    { texture: bayer },
    raw.bayerData.subarray(cropTop * raw.width + cropLeft),
    { bytesPerRow: raw.width * 2 },
    { width: effW, height: effH },
  );
  const norm = device.createTexture({ size, format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
  const demos = device.createTexture({ size, format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });

  const levelsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(levelsBuf, 0, new Float32Array([raw.blackLevel, raw.whiteLevel, 0, 0]));
  const cfaBuf = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(cfaBuf, 0, packCfa6(shiftCfa6(raw.cfa6, cropLeft, cropTop)));

  const unpackPipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: unpackShader }), entryPoint: 'main' } });
  const demosPipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: demosaicShader }), entryPoint: 'main' } });

  const enc = device.createCommandEncoder();
  const uPass = enc.beginComputePass();
  uPass.setPipeline(unpackPipe);
  uPass.setBindGroup(0, device.createBindGroup({ layout: unpackPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: bayer.createView() }, { binding: 1, resource: norm.createView() }, { binding: 2, resource: { buffer: levelsBuf } },
  ]}));
  uPass.dispatchWorkgroups(Math.ceil(effW / 8), Math.ceil(effH / 8));
  uPass.end();
  const dPass = enc.beginComputePass();
  dPass.setPipeline(demosPipe);
  dPass.setBindGroup(0, device.createBindGroup({ layout: demosPipe.getBindGroupLayout(0), entries: [
    { binding: 0, resource: norm.createView() }, { binding: 1, resource: demos.createView() }, { binding: 2, resource: { buffer: cfaBuf } },
  ]}));
  dPass.dispatchWorkgroups(Math.ceil(effW / 8), Math.ceil(effH / 8));
  dPass.end();

  // Full readback. bytesPerRow must be 256-aligned: ceil(effW*8 / 256)*256.
  const BPR = Math.ceil((effW * 8) / 256) * 256;
  const readBuf = device.createBuffer({ size: BPR * effH, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyTextureToBuffer({ texture: demos }, { buffer: readBuf, bytesPerRow: BPR }, { width: effW, height: effH });
  device.queue.submit([enc.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  log('mapAsync done');
  const d8 = new Uint8Array(readBuf.getMappedRange());
  const t1 = performance.now();
  const P = new Float32Array(effW * effH * 4);
  for (let y = 0; y < effH; y++) {
    let o = y * BPR;
    const ro = y * effW * 4;
    for (let x = 0; x < effW; x++) {
      for (let k = 0; k < 4; k++) {
        P[ro + x * 4 + k] = HALF_LUT[d8[o] | (d8[o + 1] << 8)];
        o += 2;
      }
    }
  }
  readBuf.unmap();
  log(`readback ${effW}x${effH} converted in ${(performance.now() - t1).toFixed(0)}ms`);

  // 1) Autocorr helper for a 2D field.
  function autocorr(field: Float32Array, w: number, h: number, lags: number[]) {
    const rowCorr: number[] = [], colCorr: number[] = [];
    let mean = 0;
    for (let i = 0; i < w * h; i++) mean += field[i];
    mean /= w * h;
    const dev = new Float32Array(w * h);
    let v0 = 0;
    for (let i = 0; i < w * h; i++) { dev[i] = field[i] - mean; v0 += dev[i] * dev[i]; }
    if (v0 === 0) return { row: lags.map(() => 0), col: lags.map(() => 0), dev };
    for (const lag of lags) {
      let sr = 0, sc = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w - lag; x++) sr += dev[y * w + x] * dev[y * w + x + lag];
      for (let y = 0; y < h - lag; y++) for (let x = 0; x < w; x++) sc += dev[y * w + x] * dev[(y + lag) * w + x];
      rowCorr.push(sr / v0); colCorr.push(sc / v0);
    }
    return { row: rowCorr, col: colCorr, dev };
  }

  // autocorr on the HIGH-PASSED field (residual = field - 9x9 box avg), so a
  // small grid riding on a gradient shows up (raw autocorr is dominated by the
  // gradient).
  function hpAutocorr(field: Float32Array, w: number, h: number, lags: number[]) {
    const R = 9, hh = 4;
    const res = new Float32Array(w * h);
    let v0 = 0;
    for (let y = hh; y < h - hh; y++) {
      for (let x = hh; x < w - hh; x++) {
        let s = 0;
        for (let j = -hh; j <= hh; j++) for (let i = -hh; i <= hh; i++) s += field[(y + j) * w + x + i];
        const r = field[y * w + x] - s / (R * R);
        res[y * w + x] = r;
        v0 += r * r;
      }
    }
    const row: number[] = [], col: number[] = [];
    for (const lag of lags) {
      let sr = 0, sc = 0;
      for (let y = hh; y < h - hh; y++) for (let x = hh; x < w - hh - lag; x++) sr += res[y * w + x] * res[y * w + x + lag];
      for (let y = hh; y < h - hh - lag; y++) for (let x = hh; x < w - hh; x++) sc += res[y * w + x] * res[(y + lag) * w + x];
      row.push(sr / v0); col.push(sc / v0);
    }
    return { row, col };
  }

  // 2) Source-G in the UNCLIPPED sky range (mean G in [0.7, 0.97]): the user's
  // magenta region. Pick the flattest boxes, high-pass + autocorr.
  const BX = 128;
  const gx = Math.ceil(effW / BX), gy = Math.ceil(effH / BX);
  const boxes: { bx0: number, by0: number, mean: number, varp: number }[] = [];
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const bx0 = i * BX, by0 = j * BX;
      if (bx0 + BX > effW || by0 + BX > effH) continue;
      let sum = 0, sum2 = 0;
      for (let y = 0; y < BX; y += 4) {
        const base = ((by0 + y) * effW + bx0) * 4 + 1;
        for (let x = 0; x < BX; x += 4) {
          const g = P[base + x * 4];
          sum += g; sum2 += g * g;
        }
      }
      const n = (BX / 4) * (BX / 4);
      const mean = sum / n;
      const varp = Math.sqrt(Math.max(sum2 / n - mean * mean, 0));
      boxes.push({ bx0, by0, mean, varp });
    }
  }
  const skyBoxes = boxes.filter((b) => b.mean >= 0.7 && b.mean <= 0.97);
  skyBoxes.sort((a, b) => a.varp - b.varp);
  log(`SOURCE G — flattest ${Math.min(4, skyBoxes.length)} unclipped-sky boxes (G 0.7-0.97), HIGH-PASSED autocorr (R1/C1 R4/C4 R8/C8):`);
  const LAGS = [1, 2, 3, 4, 5, 6, 8, 12, 16];
  for (const b of skyBoxes.slice(0, 4)) {
    const G = new Float32Array(BX * BX);
    for (let y = 0; y < BX; y++) for (let x = 0; x < BX; x++) G[y * BX + x] = P[((b.by0 + y) * effW + (b.bx0 + x)) * 4 + 1];
    const ac = hpAutocorr(G, BX, BX, LAGS);
    const r4 = ac.row[3], c4 = ac.col[3];
    const s = `  box(${b.bx0},${b.by0}) mean=${b.mean.toFixed(3)} var=${b.varp.toFixed(4)}  R1${ac.row[0].toFixed(2)}/C1${ac.col[0].toFixed(2)} R4${r4.toFixed(2)}/C4${c4.toFixed(2)} R8${ac.row[6].toFixed(2)}/C8${ac.col[6].toFixed(2)}` +
      ((r4 > 0.4 && ac.row[0] < 0.3) || (c4 > 0.4 && ac.col[0] < 0.3) ? '  <-- LATTICE' : '');
    log(s);
  }

  // 3) CSS-style BILINEAR downscale of source G at 19:1 (4-tap, like Chrome),
  // high-passed autocorr. Box-average lowpasses; bilinear aliases -- the
  // Moire mechanism.
  const SCALE = 19;
  const DW = Math.floor(effW / SCALE), DH = Math.floor(effH / SCALE);
  const dB = new Float32Array(DW * DH);
  const dl = new Float32Array(DW * DH);
  for (let y = 0; y < DH; y++) {
    const sy = y * SCALE, fy = sy - Math.floor(sy), yi = Math.floor(sy);
    for (let x = 0; x < DW; x++) {
      const sx = x * SCALE, fx = sx - Math.floor(sx), xi = Math.floor(sx);
      const g00 = P[((yi + 0) * effW + (xi + 0)) * 4 + 1];
      const g10 = P[((yi + 0) * effW + Math.min(xi + 1, effW - 1)) * 4 + 1];
      const g01 = P[((Math.min(yi + 1, effH - 1)) * effW + (xi + 0)) * 4 + 1];
      const g11 = P[((Math.min(yi + 1, effH - 1)) * effW + Math.min(xi + 1, effW - 1)) * 4 + 1];
      dB[y * DW + x] = g00 * (1 - fx) * (1 - fy) + g10 * fx * (1 - fy) + g01 * (1 - fx) * fy + g11 * fx * fy;
    }
  }
  const dac = hpAutocorr(dB, DW, DH, LAGS);
  log(`BILINEAR 19:1 downscale of SOURCE G, HIGH-PASSED autocorr (${DW}x${DH}):`);
  LAGS.forEach((lag, i) => log(`  ${lag}: row ${dac.row[i].toFixed(3)}  col ${dac.col[i].toFixed(3)}`));
  const r1 = dac.row[0], c1 = dac.col[0], r4 = dac.row[3], c4 = dac.col[3];
  log(`bilinear discriminator: row corr4-corr1 = ${(r4 - r1).toFixed(3)}, col = ${(c4 - c1).toFixed(3)}`);
  log(((r4 - r1) > 0.3 || (c4 - c1) > 0.3)
    ? '>>> LATTICE PRESENT after bilinear downscale of SOURCE G'
    : '>>> source G is clean under bilinear downscale too -- grid must come from ops/display beyond demosaic');

  // 4) REPLICATE THE DEFAULT RENDER IN JS: demosaic -> WB(gains) -> camera
  // color matrix -> TONE (camera look, per-channel) -> sRGB. Fresh open ALWAYS
  // runs the tone op (MANDATORY_KINDS) with neutral params + look='camera':
  // per-channel exp2(LOG_MIN + lut(logToNorm(c))·(LOG_MAX-LOG_MIN)) where lut =
  // logToNorm(cameraOutput(sampleAcrCurve(x))). The prior repro MISSED this
  // stage -- that is why it came out 4-5 EV dark with no magenta.
  const srgbLut = new Uint8Array(65536);
  for (let i = 0; i < 65536; i++) {
    const x = i / 65535;
    const y = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    srgbLut[i] = Math.round(y * 255);
  }
  const srgb8 = (x: number) => (x >= 1 ? 255 : srgbLut[(x < 0 ? 0 : x) * 65535 | 0]);
  const toneLut = buildToneLuts({ contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 }, 'camera');
  const toneMap = (v: number) => Math.pow(2, LOG_MIN + sampleToneLut(toneLut, logToNorm(v)) * (LOG_MAX - LOG_MIN));
  const g = raw.asShotGains ?? { r: 1, g: 1, b: 1 };
  const M = raw.colorMatrix;
  const t2 = performance.now();
  const D = new Uint8Array(effW * effH * 3);
  for (let i = 0; i < effW * effH; i++) {
    const o = i * 4;
    const r = P[o] * g.r, gg = P[o + 1] * g.g, b = P[o + 2] * g.b;
    const or = M[0] * r + M[1] * gg + M[2] * b;
    const og = M[3] * r + M[4] * gg + M[5] * b;
    const ob = M[6] * r + M[7] * gg + M[8] * b;
    D[i * 3] = srgb8(toneMap(or)); D[i * 3 + 1] = srgb8(toneMap(og)); D[i * 3 + 2] = srgb8(toneMap(ob));
  }
  log(`JS default render (WB+matrix+camera-look tone+sRGB) done in ${(performance.now() - t2).toFixed(0)}ms`);

  // Localize the user's magenta: R>=250, B>=235, G 215-245.
  let magN = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let y = 0; y < effH; y++) {
    for (let x = 0; x < effW; x++) {
      const o = (y * effW + x) * 3;
      if (D[o] >= 250 && D[o + 2] >= 235 && D[o + 1] >= 215 && D[o + 1] <= 245) {
        magN++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  log(`display-sRGB magenta px: ${magN} (${(100 * magN / (effW * effH)).toFixed(1)}%) bbox x[${minX}..${maxX}] y[${minY}..${maxY}]`);
  if (magN > 0) {
    // Center the box on the BRIGHTEST magenta pixel (user's view: R=255,B=239,
    // G=226-229) -- the bbox center can fall in a dark gap.
    let best = { g: -1, x: 0, y: 0 };
    for (let y = 0; y < effH; y++) {
      for (let x = 0; x < effW; x++) {
        const o = (y * effW + x) * 3;
        if (D[o] >= 250 && D[o + 2] >= 235 && D[o + 1] >= 215 && D[o + 1] <= 245 && D[o + 1] > best.g) {
          best = { g: D[o + 1], x, y };
        }
      }
    }
    log(`brightest magenta px (${best.x},${best.y}) = R${D[(best.y * effW + best.x) * 3]} G${best.g} B${D[(best.y * effW + best.x) * 3 + 2]} (user: 255,226-229,239)`);
    const cx = best.x, cy = best.y;
    const HB = 128;
    const bx = Math.max(0, Math.min(cx - HB / 2, effW - HB));
    const by = Math.max(0, Math.min(cy - HB / 2, effH - HB));
    // display G 8-bit in the box
    let gmin = 255, gmax = 0, gsum = 0;
    for (let y = 0; y < HB; y++) for (let x = 0; x < HB; x++) {
      const v = D[((by + y) * effW + (bx + x)) * 3 + 1];
      if (v < gmin) gmin = v; if (v > gmax) gmax = v; gsum += v;
    }
    log(`display G in magenta box (${bx},${by}): [${gmin}..${gmax}] mean ${(gsum / (HB * HB)).toFixed(1)} (user: 226-229)`);
    // DISPLAY G high-passed autocorr in the box -- the lattice check on what
    // the user actually sees (user screenshot: resonance at L4, R0.588/C0.427).
    const DG = new Float32Array(HB * HB);
    for (let y = 0; y < HB; y++) for (let x = 0; x < HB; x++) DG[y * HB + x] = D[((by + y) * effW + (bx + x)) * 3 + 1];
    const dac = hpAutocorr(DG, HB, HB, [1, 2, 3, 4, 5, 6, 8, 12, 16]);
    const dl = [1, 2, 3, 4, 5, 6, 8, 12, 16];
    log('  DISPLAY G high-passed autocorr lags: ' + dl.map((l, i) => `${l} R${dac.row[i].toFixed(2)}C${dac.col[i].toFixed(2)}`).join('  '));
    const dR1 = dac.row[0], dC1 = dac.col[0], dR4 = dac.row[3], dC4 = dac.col[3];
    log(`  display discriminator: row corr4-corr1 = ${(dR4 - dR1).toFixed(3)}, col = ${(dC4 - dC1).toFixed(3)}`);
    log(((dR4 - dR1) > 0.2 || (dC4 - dC1) > 0.2)
      ? '  >>> LATTICE PRESENT in DISPLAY G (the user-visible grid)'
      : '  >>> display G clean (no lattice after full chain)');
    // source P autocorr at many lags in the SAME box (R, G, B channels)
    const BLAGS = [1, 2, 3, 4, 5, 6, 8, 12, 16, 30, 38, 45, 57, 60, 63, 66, 70, 76, 80, 90, 100, 114];
    const chans = ['R', 'G', 'B'];
    const peakByChan = chans.map((ch) => {
      const chIdx = ch === 'R' ? 0 : ch === 'G' ? 1 : 2;
      const G = new Float32Array(HB * HB);
      for (let y = 0; y < HB; y++) for (let x = 0; x < HB; x++) G[y * HB + x] = P[((by + y) * effW + (bx + x)) * 4 + chIdx];
      const ac = hpAutocorr(G, HB, HB, BLAGS);
      // find resonance: max over lags>3 of corr(lag) - corr(lag-1) AND corr(lag)-corr(1)
      let best = { lag: -1, val: -1 };
      for (let i = 3; i < BLAGS.length; i++) {
        const v = Math.max(ac.row[i], ac.col[i]) - Math.max(ac.row[0], ac.col[0]);
        if (v > best.val) best = { lag: BLAGS[i], val: v };
      }
      return { ch, ...best, r1: ac.row[0], c1: ac.col[0] };
    });
    log('source-P resonance scan in magenta box (resonance = corr(lag) - corr(1)):');
    for (const p of peakByChan) log(`  ${p.ch}: best resonance lag=${p.lag} delta=${p.val.toFixed(2)} (corr1 R${p.r1.toFixed(2)}/C${p.c1.toFixed(2)})`);
    // detailed print of G-channel lags 1..20
    const GG = new Float32Array(HB * HB);
    for (let y = 0; y < HB; y++) for (let x = 0; x < HB; x++) GG[y * HB + x] = P[((by + y) * effW + (bx + x)) * 4 + 1];
    const gac = hpAutocorr(GG, HB, HB, [1, 2, 3, 4, 5, 6, 8, 12, 16]);
    log('  source P G high-passed autocorr lags: ' + [1, 2, 3, 4, 5, 6, 8, 12, 16].map((l, i) => `${l} R${gac.row[i].toFixed(2)}C${gac.col[i].toFixed(2)}`).join('  '));
  }
  // 5) GROUND TRUTH: drive the REAL Pipeline (create -> load -> render ->
  // exportImage) on the same raw and analyze ITS output. Whatever exportImage
  // returns IS the app's rendered frame (same dispatchOps chain, tone.wgsl,
  // blit) -- no JS repro in between. Settles whether sample.raf can even
  // produce the user's bright flat magenta field.
  try {
    const canvas = document.createElement('canvas');
    canvas.width = effW; canvas.height = effH;
    canvas.style.position = 'fixed'; canvas.style.left = '-100000px'; canvas.style.top = '0';
    document.body.appendChild(canvas);
    const { Pipeline } = await import('./src/gpu/pipeline');
    const pipe = await Pipeline.create(canvas);
    pipe.load(raw);
    const ops = [
      { kind: 'profile', profile: 'camera' },
      { kind: 'exposure', ev: 0 },
      { kind: 'whiteBalance', kelvin: 0, tint: 0, gains: raw.asShotGains ?? { r: 1, g: 1, b: 1 } },
    ];
    pipe.render(ops as never);
    const blob = await pipe.exportImage(ops as never, { format: 'png', bitDepth: 8, longEdge: null });
    const bmp = await createImageBitmap(blob);
    const c2 = document.createElement('canvas');
    c2.width = bmp.width; c2.height = bmp.height;
    const ctx = c2.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let m = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        const o = (y * bmp.width + x) * 4;
        if (img[o] >= 250 && img[o + 2] >= 235 && img[o + 1] >= 215 && img[o + 1] <= 245) {
          m++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    log(`REAL PIPELINE exportImage ${bmp.width}x${bmp.height}: magenta px ${m} (${(100 * m / (bmp.width * bmp.height)).toFixed(1)}%) bbox x[${minX}..${maxX}] y[${minY}..${maxY}]`);
    let bg = -1, bx = 0, by = 0;
    for (let y = 0; y < bmp.height; y++) {
      for (let x = 0; x < bmp.width; x++) {
        const o = (y * bmp.width + x) * 4;
        if (img[o] >= 250 && img[o + 2] >= 235 && img[o + 1] >= 215 && img[o + 1] <= 245 && img[o + 1] > bg) {
          bg = img[o + 1]; bx = x; by = y;
        }
      }
    }
    log(`real brightest magenta (${bx},${by}) = R${img[(by * bmp.width + bx) * 4]} G${bg} B${img[(by * bmp.width + bx) * 4 + 2]} (user: 255,226-229,239)`);
    // Stash a small thumbnail as base64 for visual inspection.
    const thumb = await pipe.exportImage(ops as never, { format: 'png', bitDepth: 8, longEdge: 640 });
    const b64 = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(thumb);
    });
    (window as any).__exportB64 = b64;
    log('THUMB READY');
  } catch (e) {
    log('REAL PIPELINE failed: ' + (e as Error).message);
  }

  // 6) CHAIN-BUG TEST (file-independent): feed the real Pipeline a SYNTHETIC
  // perfectly-flat magenta bayer (every CFA cell constant). If the rendered
  // output has a periodic G grid, the chain itself creates it -- the user's
  // symptom regardless of their file. If clean, the grid lives in the source.
  try {
    const w = 2048, h = 2048;
    const bl = raw.blackLevel, wh = raw.whiteLevel;
    const lin2val = (L: number) => Math.round(bl + L * (wh - bl));
    const Lc = { r: 0.55, g: 0.45, b: 0.55 }; // mid-bright, nothing clips
    const cfa = raw.cfa6;
    const vOf = (ch: number) => (ch === 0 ? lin2val(Lc.r) : ch === 1 ? lin2val(Lc.g) : lin2val(Lc.b));
    const bayer = new Uint16Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) bayer[y * w + x] = vOf(cfa[((y % 6) * 6) + (x % 6)]);
    }
    const synRaw = {
      width: w, height: h, effectiveWidth: w, effectiveHeight: h,
      leftMargin: 0, topMargin: 0, bayerData: bayer,
      cfa6: raw.cfa6, blackLevel: bl, whiteLevel: wh,
      colorMatrix: raw.colorMatrix, camXyz: raw.camXyz,
      asShotGains: raw.asShotGains ?? { r: 1, g: 1, b: 1 },
    } as never;
    const canvas3 = document.createElement('canvas');
    canvas3.width = w; canvas3.height = h;
    canvas3.style.position = 'fixed'; canvas3.style.left = '-100000px';
    document.body.appendChild(canvas3);
    const { Pipeline } = await import('./src/gpu/pipeline');
    const pipe3 = await Pipeline.create(canvas3);
    pipe3.load(synRaw);
    const synOps = [
      { kind: 'profile', profile: 'camera' },
      { kind: 'exposure', ev: 0 },
      { kind: 'whiteBalance', kelvin: 0, tint: 0, gains: raw.asShotGains ?? { r: 1, g: 1, b: 1 } },
    ];
    pipe3.render(synOps as never);
    const blob3 = await pipe3.exportImage(synOps as never, { format: 'png', bitDepth: 8, longEdge: null });
    const bmp3 = await createImageBitmap(blob3);
    const c3 = document.createElement('canvas'); c3.width = bmp3.width; c3.height = bmp3.height;
    const ctx3 = c3.getContext('2d')!; ctx3.drawImage(bmp3, 0, 0);
    const img3 = ctx3.getImageData(0, 0, bmp3.width, bmp3.height).data;
    const px = (x: number, y: number) => `R${img3[(y * w + x) * 4]} G${img3[(y * w + x) * 4 + 1]} B${img3[(y * w + x) * 4 + 2]}`;
    log(`SYNTH flat magenta ${w}x${h}: corner ${px(1, 1)}, (1000,1000) ${px(1000, 1000)}`);
    // Row-mean / col-mean spread on G: flat input => ~0. Any spread = periodic output.
    let rowMin = 1e9, rowMax = -1, colMin = 1e9, colMax = -1;
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) s += img3[(y * w + x) * 4 + 1];
      const m = s / w; rowMin = Math.min(rowMin, m); rowMax = Math.max(rowMax, m);
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = 0; y < h; y++) s += img3[(y * w + x) * 4 + 1];
      const m = s / h; colMin = Math.min(colMin, m); colMax = Math.max(colMax, m);
    }
    log(`SYNTH G row-mean [${rowMin.toFixed(3)}..${rowMax.toFixed(3)}] col-mean [${colMin.toFixed(3)}..${colMax.toFixed(3)}] (flat -> ~0 spread)`);
    const SG = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) SG[y * w + x] = img3[(y * w + x) * 4 + 1];
    const sac = hpAutocorr(SG, w, h, [1, 2, 3, 4, 5, 6, 8, 12, 16]);
    const sl = [1, 2, 3, 4, 5, 6, 8, 12, 16];
    log('SYNTH G high-passed autocorr lags: ' + sl.map((l, i) => `${l} R${sac.row[i].toFixed(2)}C${sac.col[i].toFixed(2)}`).join('  '));
    log('SYNTH discriminator: row corr4-corr1 = ' + (sac.row[3] - sac.row[0]).toFixed(3) + ', col = ' + (sac.col[3] - sac.col[0]).toFixed(3));

    // Isolate the DEMOSAIC: manual unpack+MHC on the synthetic flat bayer,
    // read back the rgba16float demosaiced output, check per-channel pattern.
    const sbT = device.createTexture({ size: [w, h], format: 'r16uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: sbT }, bayer, { bytesPerRow: w * 2 }, { width: w, height: h });
    const sbN = device.createTexture({ size: [w, h], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const sbD = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
    const sbL = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(sbL, 0, new Float32Array([bl, wh, 0, 0]));
    const sbC = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(sbC, 0, packCfa6(shiftCfa6(raw.cfa6, 0, 0)));
    const sbe = device.createCommandEncoder();
    const sbup = sbe.beginComputePass();
    sbup.setPipeline(unpackPipe);
    sbup.setBindGroup(0, device.createBindGroup({ layout: unpackPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: sbT.createView() }, { binding: 1, resource: sbN.createView() }, { binding: 2, resource: { buffer: sbL } },
    ]}));
    sbup.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    sbup.end();
    const sbdp = sbe.beginComputePass();
    sbdp.setPipeline(demosPipe);
    sbdp.setBindGroup(0, device.createBindGroup({ layout: demosPipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: sbN.createView() }, { binding: 1, resource: sbD.createView() }, { binding: 2, resource: { buffer: sbC } },
    ]}));
    sbdp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    sbdp.end();
    const sbBPR = Math.ceil((w * 8) / 256) * 256;
    const sbR = device.createBuffer({ size: sbBPR * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    sbe.copyTextureToBuffer({ texture: sbD }, { buffer: sbR, bytesPerRow: sbBPR }, { width: w, height: h });
    device.queue.submit([sbe.finish()]);
    await sbR.mapAsync(GPUMapMode.READ);
    const sb8 = new Uint8Array(sbR.getMappedRange());
    const sP = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      let o = y * sbBPR;
      const ro = y * w * 4;
      for (let x = 0; x < w; x++) {
        for (let k = 0; k < 4; k++) { sP[ro + x * 4 + k] = HALF_LUT[sb8[o] | (sb8[o + 1] << 8)]; o += 2; }
      }
    }
    for (const [cn, ci] of [['R', 0], ['G', 1], ['B', 2]] as const) {
      let rmin = 1e9, rmax = -1, cmin = 1e9, cmax = -1;
      for (let y = 0; y < h; y++) {
        let s = 0;
        for (let x = 0; x < w; x++) s += sP[(y * w + x) * 4 + ci];
        const m = s / w; rmin = Math.min(rmin, m); rmax = Math.max(rmax, m);
      }
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let y = 0; y < h; y++) s += sP[(y * w + x) * 4 + ci];
        const m = s / h; cmin = Math.min(cmin, m); cmax = Math.max(cmax, m);
      }
      log(`SYNTH demosaiced ${cn} row-mean [${rmin.toFixed(5)}..${rmax.toFixed(5)}] col-mean [${cmin.toFixed(5)}..${cmax.toFixed(5)}] (flat -> ~0)`);
    }
    // First 12 G values in one row (the exact pattern)
    const gpat = [];
    for (let x = 0; x < 12; x++) gpat.push(sP[x * 4 + 1].toFixed(4));
    log('SYNTH demosaiced G row0 x0..11: ' + gpat.join(' '));

    // 7) DODGE & BURN PROOF (case #7 -- the invisible-mask feedback): on the SAME
    // synthetic flat bayer, render with a painted dodge mask and scan the output.
    // Filter: (a) pixels OUTSIDE the stroke must be bit-identical to the no-dodge
    // render (a mask moves only what was painted); (b) pixels INSIDE the stroke
    // must be strictly brighter (dodge lifts). Deterministic pass/fail proving the
    // mask drives the image -- the red overlay the fix adds makes exactly this
    // visible. Drawn from the CPU-authoritative paintMask (no GPU readback).
    const [mw, mh] = maskDims(w, h);
    const mask = new Float32Array(mw * mh);
    // One soft dodge stamp at the mask center (full falloff, density 1.0 at the
    // center). Mask radius 200 of 1024 == image radius 400 of 2048.
    paintStroke(mask, mw, mh, mw / 2, mh / 2, mw / 2, mh / 2, 200, 1);
    // Baseline: the same ops with no dodgeBurn op.
    pipe3.render(synOps as never);
    const blobB = await pipe3.exportImage(synOps as never, { format: 'png', bitDepth: 8, longEdge: null });
    // Dodge: upload the mask texture, dispatch a dodgeBurn op (amount 25 -> ev 1).
    pipe3.setDodgeMask(maskToBytes(mask));
    const dodgeOps = [...synOps, { kind: 'dodgeBurn', amount: 25, size: 20, opacity: 50, feather: 0, mask: maskToOp(mask), maskW: mw, maskH: mh }];
    pipe3.render(dodgeOps as never);
    const blobD = await pipe3.exportImage(dodgeOps as never, { format: 'png', bitDepth: 8, longEdge: null });
    const bmpB = await createImageBitmap(blobB);
    const bmpD = await createImageBitmap(blobD);
    const cB = document.createElement('canvas'); cB.width = bmpB.width; cB.height = bmpB.height;
    const cD = document.createElement('canvas'); cD.width = bmpD.width; cD.height = bmpD.height;
    const ctxB = cB.getContext('2d')!; ctxB.drawImage(bmpB, 0, 0);
    const ctxD = cD.getContext('2d')!; ctxD.drawImage(bmpD, 0, 0);
    const imgB = ctxB.getImageData(0, 0, bmpB.width, bmpB.height).data;
    const imgD = ctxD.getImageData(0, 0, bmpD.width, bmpD.height).data;
    const W = bmpB.width, H = bmpB.height;
    // The stroke in image space: mask center + radius, scaled by W/mw.
    const cx = W / 2, cy = H / 2, cr = 200 * (W / mw), cr2 = cr * cr;
    const lum = (img: Uint8ClampedArray, x: number, y: number) =>
      0.2126 * img[(y * W + x) * 4] + 0.7152 * img[(y * W + x) * 4 + 1] + 0.0722 * img[(y * W + x) * 4 + 2];
    let outMaxDelta = 0, inSumB = 0, inSumD = 0, nIn = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ddx = x + 0.5 - cx, ddy = y + 0.5 - cy;
        const d2 = ddx * ddx + ddy * ddy;
        // 4px margin keeps the bilinear mask edge out of both regions.
        if (d2 <= (cr - 4) * (cr - 4)) { inSumB += lum(imgB, x, y); inSumD += lum(imgD, x, y); nIn++; }
        else if (d2 >= (cr + 4) * (cr + 4)) outMaxDelta = Math.max(outMaxDelta, Math.abs(lum(imgB, x, y) - lum(imgD, x, y)));
      }
    }
    const inB = inSumB / nIn, inD = inSumD / nIn;
    const lift = inD / inB;
    const pass = outMaxDelta <= 1 && lift > 1.02;
    log(`DODGE PROOF: inside mean ${inB.toFixed(3)} -> ${inD.toFixed(3)} (lift x${lift.toFixed(3)}), outside max|lum delta| ${outMaxDelta.toFixed(3)} (expect ~0)`);
    log(`DODGE FILTER: ${pass ? 'PASS' : 'FAIL'} -- mask moves only painted pixels (outsideDelta=${outMaxDelta.toFixed(3)}<=1:${outMaxDelta <= 1}, insideLift=${lift.toFixed(3)}>1.02:${lift > 1.02})`);

    // 7b) OPACITY IS LIVE POST-PAINT (the "opacity ก็เหมือนไม่ทำงาน" complaint):
    // the SAME painted mask, re-uploaded through effectiveMask at opacity 25/50/
    // 100, must render with monotonically rising inside lift. A sub-saturated
    // disc mask (density 0.5) keeps the whole 25..100 range off the clamp.
    const mask2 = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const ddx = x + 0.5 - mw / 2, ddy = y + 0.5 - mh / 2;
      if (ddx * ddx + ddy * ddy <= 200 * 200) mask2[y * mw + x] = 0.5;
    }
    const renderAndLift = async (bytes: Uint8Array) => {
      pipe3.setDodgeMask(bytes);
      pipe3.render(dodgeOps as never);
      const b = await pipe3.exportImage(dodgeOps as never, { format: 'png', bitDepth: 8, longEdge: null });
      const bm = await createImageBitmap(b);
      const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
      const x = c.getContext('2d')!; x.drawImage(bm, 0, 0);
      const im = x.getImageData(0, 0, bm.width, bm.height).data;
      let s = 0;
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        const ddx = xx + 0.5 - cx, ddy = y + 0.5 - cy;
        if (ddx * ddx + ddy * ddy <= (cr - 4) * (cr - 4)) s += lum(im, xx, y);
      }
      return s / nIn / inB; // lift vs the no-dodge baseline
    };
    const lifts = [
      await renderAndLift(maskToBytes(effectiveMask(mask2, mw, mh, 25, 0))),
      await renderAndLift(maskToBytes(effectiveMask(mask2, mw, mh, 50, 0))),
      await renderAndLift(maskToBytes(effectiveMask(mask2, mw, mh, 100, 0))),
    ];
    const mono = lifts[0] < lifts[1] && lifts[1] < lifts[2];
    log(`OPACITY LIVE PROOF: inside lift at opacity 25/50/100 = x${lifts.map((v) => v.toFixed(3)).join(' / x')}`);
    log(`OPACITY FILTER: ${mono ? 'PASS' : 'FAIL'} -- post-paint opacity scales the existing mark monotonically (${lifts.map((v) => v.toFixed(3)).join(' < ')}?)`);

    // 7c) FEATHER IS LIVE (the edge dark/light softness): blur the same disc mask
    // (effectiveMask feather 100, r=41 in mask space == 82px in image space). The
    // blur must bleed density past the hard disc edge (outside annulus 410..470px
    // gains lift) while the deep interior (ring 100..300px) keeps its lift.
    const scanLift = async (bytes: Uint8Array, fromR: number, toR: number) => {
      pipe3.setDodgeMask(bytes);
      pipe3.render(dodgeOps as never);
      const b = await pipe3.exportImage(dodgeOps as never, { format: 'png', bitDepth: 8, longEdge: null });
      const bm = await createImageBitmap(b);
      const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
      const x = c.getContext('2d')!; x.drawImage(bm, 0, 0);
      const im = x.getImageData(0, 0, bm.width, bm.height).data;
      let s = 0, n = 0;
      for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) {
        const ddx = xx + 0.5 - cx, ddy = y + 0.5 - cy, d2 = ddx * ddx + ddy * ddy;
        if (d2 >= fromR * fromR && d2 <= toR * toR) { s += lum(im, xx, y); n++; }
      }
      return s / n / inB;
    };
    const sharpBytes = maskToBytes(effectiveMask(mask2, mw, mh, 50, 0));
    const softBytes = maskToBytes(effectiveMask(mask2, mw, mh, 50, 100));
    const [outSharp, outSoft, inSharp, inSoft] = await Promise.all([
      scanLift(sharpBytes, 410, 470), scanLift(softBytes, 410, 470),
      scanLift(sharpBytes, 100, 300), scanLift(softBytes, 100, 300),
    ]);
    const bleed = outSoft > outSharp + 0.005;
    const interiorKept = Math.abs(inSoft / inSharp - 1) < 0.02;
    log(`FEATHER LIVE PROOF: outside-annulus lift x${outSharp.toFixed(3)} (sharp) -> x${outSoft.toFixed(3)} (feather 100); interior ring x${inSharp.toFixed(3)} -> x${inSoft.toFixed(3)}`);
    log(`FEATHER FILTER: ${bleed && interiorKept ? 'PASS' : 'FAIL'} -- edge bleeds past the hard disc (${outSharp.toFixed(3)}->${outSoft.toFixed(3)}) while the interior holds (${(inSoft / inSharp).toFixed(3)}x)`);

    // 8) CROP-AFTER-FRAME PROOF (case #6 -- "crop after frame = ภาพจะพัง").
    // The frame op runs LAST; with a crop it must wrap the CROP rect
    // (cropFrac), not the uncropped texture. On the flat magenta 2048x2048 with
    // a 4:3 crop (cropFrac [1, 0.75], border b=0.06) the EXPORT is the crop
    // rect (2048x1536, bars excluded) and must show, in export rows:
    //   y[0,92)      = frame rebate (0.02 linear -> ~39 sRGB each)
    //   y[37,74]     = sprocket holes (0.18 -> ~118 sRGB)   <-- the DISCRIMINATOR
    //   y[92,1444]   = magenta image (scaled by 1-2b inside the frame)
    //   y[1444,1536] = rebate + holes [1471,1508]
    // A frame that ignored the crop (stale cropFrac = 1,1) puts its rebate in
    // the EXCLUDED bars -> the export renders ALL magenta, frame vanished.
    const cfCrop = { kind: 'crop', aspect: '4:3', rotate90: 0, angle: 0 } as never;
    const cfFrame = { kind: 'frame', style: '135' } as never;
    const renderImg = async (ops: unknown[]) => {
      pipe3.render(ops as never);
      const b = await pipe3.exportImage(ops as never, { format: 'png', bitDepth: 8, longEdge: null });
      const bm = await createImageBitmap(b);
      const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height;
      const x = c.getContext('2d')!; x.drawImage(bm, 0, 0);
      const im = x.getImageData(0, 0, bm.width, bm.height).data;
      log(`CROP-FRAME EXPORT ${ops.length} ops: ${bm.width}x${bm.height}`);
      return { im, W: bm.width, H: bm.height };
    };
    const c = (im: Uint8ClampedArray, W: number, y: number, x = 1024) => {
      const o = (y * W + x) * 4;
      return `R${im[o]}G${im[o + 1]}B${im[o + 2]}`;
    };
    const cnum = (im: Uint8ClampedArray, W: number, y: number, x = 1024) => {
      const o = (y * W + x) * 4;
      return { r: im[o], g: im[o + 1], b: im[o + 2] };
    };
    const isMag = (p: { r: number; g: number; b: number }) => p.r > 200 && p.b > 200 && p.g < 190;
    const isReb = (p: { r: number; g: number; b: number }) => p.r < 60 && p.g < 60 && p.b < 60;
    // Film band content at this (row,x): neither the magenta image nor pure
    // rebate -- the real strip's holes/branding read as dark-red midtones here.
    const isFilm = (p: { r: number; g: number; b: number }) => !isMag(p) && !isReb(p);
    // (a) crop only -> the whole export is magenta (no frame).
    const A = await renderImg([...synOps, cfCrop]);
    const Aok = isMag(cnum(A.im, A.W, 100)) && isMag(cnum(A.im, A.W, 700)) && isMag(cnum(A.im, A.W, 1400));
    log(`CROP-FRAME PROOF A (crop only): 100=${c(A.im, A.W, 100)} 700=${c(A.im, A.W, 700)} 1400=${c(A.im, A.W, 1400)} -> ${Aok ? 'all-magenta' : 'NOT-magenta'}`);
    // (b) frame only -> full 2048x2048, rebate band rows [0,123]+[1925,2048]
    // (the vendored strip renders holes/mark inside the band -- check the pure
    // rebate rows 5/2043, above/below the strip's holes+mark), image magenta
    // in between.
    const B = await renderImg([...synOps, cfFrame]);
    const Bok = isReb(cnum(B.im, B.W, 5)) && isMag(cnum(B.im, B.W, 1000)) && isReb(cnum(B.im, B.W, 2043));
    log(`CROP-FRAME PROOF B (frame only): 5=${c(B.im, B.W, 5)} 1000=${c(B.im, B.W, 1000)} 2043=${c(B.im, B.W, 2043)} -> ${Bok ? 'rebate+magenta+rebate' : 'layout-wrong'}`);
    // (c) crop + frame -> the decisive layout (export 2048x1536, the crop
    // rect): rebate [0,28], film [28,65], rebate [65,92], image [92,1444],
    // rebate [1444,1536] with film [1471,1508].
    const C = await renderImg([...synOps, cfCrop, cfFrame]);
    const Crows = [15, 46, 200, 700, 1200, 1500, 1520];
    log('CROP-FRAME PROOF C rows: ' + Crows.map((y) => `${y}:${c(C.im, C.W, y)}`).join(' '));
    const cC = Crows.map((y) => cnum(C.im, C.W, y));
    const Cok = isReb(cC[0]) && isFilm(cC[1]) && isMag(cC[2]) && isMag(cC[3]) && isMag(cC[4]) && isFilm(cC[5]) && isReb(cC[6]);
    log(`CROP-FRAME FILTER: ${Cok ? 'PASS' : 'FAIL'} -- frame wraps the crop rect (rebate+film+magenta at expected export rows). Aok=${Aok} Bok=${Bok}`);

    // 9) CROP WORKBENCH PROOF (case #2 -- "crop/rotate zooms in"). The VIEW
    // (canvas blit [1,1]) shows the FULL texture, so a crop that bakes black
    // letterbox bars into it makes the image refit (the zoom jump). On the
    // flat magenta 2048x2048, a 4:3 aspect-only crop must leave the FULL image
    // visible (workbench identity-crop) -- zero black rows in displayTexture.
    // The OLD masked crop writes bars to rows 384..1663 (maskH=1536 centered)
    // -> the discriminator is blackRows === 0. Read displayTexture directly
    // (rgba16float, COPY_SRC) so the crop region isn't cut off by the export.
    const wbCrop = { kind: 'crop', aspect: '4:3', rotate90: 0, angle: 0 } as never;
    pipe3.render([...synOps, wbCrop] as never);
    const dt = (pipe3 as any).displayTexture as GPUTexture;
    const wbDev = (pipe3 as any).device as GPUDevice; // pipe3 has its OWN device
    const readRows = async (tex: GPUTexture) => {
      const wbBPR = Math.ceil((tex.width * 8) / 256) * 256;
      const wbBuf = wbDev.createBuffer({ size: wbBPR * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const wbe = wbDev.createCommandEncoder();
      wbe.copyTextureToBuffer({ texture: tex }, { buffer: wbBuf, bytesPerRow: wbBPR }, { width: tex.width, height: tex.height });
      wbDev.queue.submit([wbe.finish()]);
      await wbBuf.mapAsync(GPUMapMode.READ);
      const wb8 = new Uint8Array(wbBuf.getMappedRange());
      const means: number[] = [];
      let blackRows = 0;
      for (let y = 0; y < tex.height; y++) {
        let s = 0, o = y * wbBPR;
        for (let x = 0; x < tex.width; x++) {
          s += HALF_LUT[wb8[o] | (wb8[o + 1] << 8)];        // R
          s += HALF_LUT[wb8[o + 2] | (wb8[o + 3] << 8)];    // G
          s += HALF_LUT[wb8[o + 4] | (wb8[o + 5] << 8)];    // B
          o += 8; // rgba16float = 8 bytes/texel
        }
        const m = s / (tex.width * 3);
        means.push(m);
        if (m < 0.02) blackRows++;
      }
      return { blackRows, means };
    };
    const ctl = await readRows(dt);
    pipe3.render(synOps as never);
    const ctl0 = await readRows((pipe3 as any).displayTexture as GPUTexture);
    log(`CROP WORKBENCH control: no-crop blackRows=${ctl0.blackRows} (${ctl0.means[0].toFixed(3)}..${ctl0.means[dt.height - 1].toFixed(3)}), crop blackRows=${ctl.blackRows} (row256=${ctl.means[256].toFixed(3)} row1000=${ctl.means[1000].toFixed(3)} row1800=${ctl.means[1800].toFixed(3)})`);
    const wbOk = ctl.blackRows === 0;
    log(`CROP WORKBENCH FILTER: ${wbOk ? 'PASS' : 'FAIL'} -- aspect-only crop keeps the full image in the view (black rows ${ctl.blackRows}/${dt.height}).`);

    // 10) FILM-STRIP PROOF (case #4 -- procedural sprockets "ปลอมจัด"). The
    // '135' frame band now samples the COMMITTED film-strip texture
    // (public/frames/135-strip.png -- a real 35mm negative-scan edge downloaded
    // from Unsplash, permissive license, no runtime network). Proof = the
    // rendered band's linear pixels EQUAL the committed PNG's pixels, mirrored
    // through the shader's exact uv mapping + sRGB decode + bilinear. A
    // procedural shader can't reproduce the PNG's real grain/sprockets; a
    // missing texture reads flat rebate.
    const decodeImg = async (url: string) => {
      const bmp = await createImageBitmap(await (await fetch(url)).blob());
      const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
      const g = cv.getContext('2d')!; g.drawImage(bmp, 0, 0);
      const im = g.getImageData(0, 0, cv.width, cv.height);
      return { w: cv.width, h: cv.height, data: im.data };
    };
    const srgbLin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const strip = await decodeImg('/frames/135-strip.png'); // 2048x256 sRGB bytes
    const stripLin = new Float32Array(strip.w * strip.h * 3);
    for (let i = 0; i < strip.w * strip.h; i++) {
      for (let c = 0; c < 3; c++) stripLin[i * 3 + c] = srgbLin(strip.data[i * 4 + c]);
    }
    // Mirror of frame.wgsl's '135' band sampling at no-crop (cfx=cfy=1):
    // px2 = nx, band = py/0.06, uv.y = band*0.5 (top band), then sRGB->linear.
    const frameSample = (fx: number, fy: number, ch: number) => {
      const ny = (fy + 0.5) / 2048;
      if (ny >= 0.06) return null; // outside the top rebate band
      const u = (fx + 0.5) / 2048;
      const v = (ny / 0.06) * 0.5;
      let tx = u * strip.w - 0.5, ty = v * strip.h - 0.5;
      const x0 = Math.max(0, Math.floor(tx)), y0 = Math.max(0, Math.floor(ty));
      const x1 = Math.min(strip.w - 1, x0 + 1), y1 = Math.min(strip.h - 1, y0 + 1);
      const wx = tx - x0, wy = ty - y0;
      const at = (xx: number, yy: number) => stripLin[(yy * strip.w + xx) * 3 + ch];
      return at(x0, y0) * (1 - wx) * (1 - wy) + at(x1, y0) * wx * (1 - wy) + at(x0, y1) * (1 - wx) * wy + at(x1, y1) * wx * wy;
    };
    pipe3.render([...synOps, { kind: 'frame', style: '135' }] as never);
    const fTex = (pipe3 as any).displayTexture as GPUTexture;
    const fW2 = fTex.width, fBPR2 = Math.ceil((fW2 * 8) / 256) * 256;
    const fBuf2 = wbDev.createBuffer({ size: fBPR2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const fe2 = wbDev.createCommandEncoder();
    fe2.copyTextureToBuffer({ texture: fTex, origin: [0, 60] }, { buffer: fBuf2, bytesPerRow: fBPR2 }, { width: fW2, height: 1 });
    wbDev.queue.submit([fe2.finish()]);
    await fBuf2.mapAsync(GPUMapMode.READ);
    const f8 = new Uint8Array(fBuf2.getMappedRange());
    let maxDelta = 0, maxBand = 0;
    for (let x = 400; x < 1600; x++) {
      const o = x * 8;
      const lin = [HALF_LUT[f8[o] | (f8[o + 1] << 8)], HALF_LUT[f8[o + 2] | (f8[o + 3] << 8)], HALF_LUT[f8[o + 4] | (f8[o + 5] << 8)]];
      for (let c = 0; c < 3; c++) {
        const exp = frameSample(x, 60, c)!;
        maxDelta = Math.max(maxDelta, Math.abs(lin[c] - exp));
      }
      maxBand = Math.max(maxBand, lin[0]);
    }
    fBuf2.unmap(); fBuf2.destroy();
    const bandMatch = maxDelta < 0.03;
    const hasHoles = maxBand > 0.06; // the real sprocket holes read (not all rebate)
    const fsOk = bandMatch && hasHoles;
    log(`FILM-STRIP PROOF row 60: max |rendered - committed-PNG| = ${maxDelta.toFixed(4)} (3 ch, x 400..1600), max band lum = ${maxBand.toFixed(3)}`);
    log(`FILM-STRIP FILTER: ${fsOk ? 'PASS' : 'FAIL'} -- the 135 band IS the committed film scan (bandMatch:${bandMatch}, holes-read:${hasHoles})`);

    // 11) LEAK TEXTURE PROOF (case #8 -- procedural gradient blob "fake"). The
    // light-leak op samples the three COMMITTED rgba8unorm textures (real
    // photos, Unsplash permissive, no runtime network) and ADDS their linear
    // bytes, rotated so each texture's TOP aligns with the per-photo edge
    // (seedU % 4). Proof = the rendered pixel EXACTLY equals base + bilinear
    // (committed PNG) under the shader's uv mapping, at three hues (one
    // texture each) and with the fade envelope. A procedural shader can't
    // reproduce the PNGs' pixels.
    const leakTexs = await Promise.all(['/leaks/leak-0.png', '/leaks/leak-1.png', '/leaks/leak-2.png'].map(decodeImg));
    const leakLin = leakTexs.map((L) => {
      const f = new Float32Array(L.w * L.h * 3);
      for (let i = 0; i < L.w * L.h; i++) for (let c = 0; c < 3; c++) f[i * 3 + c] = L.data[i * 4 + c] / 255; // unorm: bytes ARE linear
      return f;
    });
    const bilin = (img: Float32Array, W: number, H: number, u: number, v: number, ch: number) => {
      let tx = u * W - 0.5, ty = v * H - 0.5;
      const x0 = Math.max(0, Math.floor(tx)), y0 = Math.max(0, Math.floor(ty));
      const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const wx = tx - x0, wy = ty - y0;
      const at = (xx: number, yy: number) => img[(yy * W + xx) * 3 + ch];
      return at(x0, y0) * (1 - wx) * (1 - wy) + at(x1, y0) * wx * (1 - wy) + at(x0, y1) * (1 - wx) * wy + at(x1, y1) * wx * wy;
    };
    const smoothstep = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    const leakWeights = (hue01: number) => {
      const h = hue01 * 2;
      const w = [Math.min(1, Math.max(0, 1 - h)), Math.max(0, 1 - Math.abs(h - 1)), Math.min(1, Math.max(0, h - 1))];
      const s = w[0] + w[1] + w[2];
      return w.map((x) => x / s);
    };
    // Mirror of lightleak.wgsl with seed 0.01 -> seedU=167772 -> edge 0 (top):
    // uv=(nx,ny), tex = sum w_i * bilin(leak_i), gain = amount*0.01 * fadeGain.
    const expectedLeak = (x: number, y: number, hue: number, fade: number, ch: number) => {
      const nx = (x + 0.5) / 2048, ny = (y + 0.5) / 2048;
      const w = leakWeights(Math.min(1, Math.max(0, hue * 0.01)));
      let tex = 0;
      for (let i = 0; i < 3; i++) tex += bilin(leakLin[i], leakTexs[i].w, leakTexs[i].h, nx, ny, ch) * w[i];
      const fadeGain = 1 - smoothstep(0, 0.35, ny); // fade 100: 1-smoothstep(0,LEAK_WIDTH,d)
      return tex * (fade === 100 ? fadeGain : 1);
    };
    setGrainSeed(0.01); // pins edge 0 for every render below
    const leakPix = async (tex: GPUTexture, x: number, y: number) => {
      const lW = tex.width;
      const lBPR = Math.ceil((lW * 8) / 256) * 256;
      const lBuf = wbDev.createBuffer({ size: lBPR, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const le = wbDev.createCommandEncoder();
      le.copyTextureToBuffer({ texture: tex, origin: [0, y] }, { buffer: lBuf, bytesPerRow: lBPR }, { width: lW, height: 1 });
      wbDev.queue.submit([le.finish()]);
      await lBuf.mapAsync(GPUMapMode.READ);
      const l8 = new Uint8Array(lBuf.getMappedRange());
      const o = x * 8;
      const rgb = [
        HALF_LUT[l8[o] | (l8[o + 1] << 8)],
        HALF_LUT[l8[o + 2] | (l8[o + 3] << 8)],
        HALF_LUT[l8[o + 4] | (l8[o + 5] << 8)],
      ];
      lBuf.unmap(); lBuf.destroy();
      return rgb;
    };
    const leakOps = (leak: unknown) => [...synOps, leak] as never;
    const LEAKP = 1024, LEAKY = 120; // near the top edge where the leaks are strong
    const leakRender = async (leak: unknown, x: number, y: number) => {
      pipe3.render(leak ? leakOps(leak) : (synOps as never));
      return leakPix((pipe3 as any).displayTexture as GPUTexture, x, y);
    };
    const base = await leakRender(null, LEAKP, LEAKY);
    const hueGot = await Promise.all([0, 50, 100].map((hue) => leakRender({ kind: 'lightleak', amount: 100, hue, fade: 0 } as never, LEAKP, LEAKY)));
    let maxLeakDelta = 0;
    for (let i = 0; i < 3; i++) for (let c = 0; c < 3; c++) {
      const exp = base[c] + expectedLeak(LEAKP, LEAKY, i * 50, 0, c);
      maxLeakDelta = Math.max(maxLeakDelta, Math.abs(hueGot[i][c] - exp));
    }
    // fade: at a deep pixel (ny > LEAK_WIDTH) fade 100 must kill the leak exactly
    const FY = 900;
    const baseF = await leakRender(null, LEAKP, FY);
    const f0 = await leakRender({ kind: 'lightleak', amount: 100, hue: 0, fade: 0 } as never, LEAKP, FY);
    const f100 = await leakRender({ kind: 'lightleak', amount: 100, hue: 0, fade: 100 } as never, LEAKP, FY);
    let maxFadeDelta = 0;
    for (let c = 0; c < 3; c++) {
      maxFadeDelta = Math.max(maxFadeDelta, Math.abs(f0[c] - (baseF[c] + expectedLeak(LEAKP, FY, 0, 0, c))));
      maxFadeDelta = Math.max(maxFadeDelta, Math.abs(f100[c] - baseF[c]));
    }
    const hueMoves = Math.abs(hueGot[0][0] - hueGot[2][0]) > 0.05; // warm vs cool textures genuinely differ
    const leakOk = maxLeakDelta < 0.04 && maxFadeDelta < 0.04 && hueMoves;
    log(`LEAK PROOF @(${LEAKP},${LEAKY}) base R=${base[0].toFixed(3)} | hue0 R=${hueGot[0][0].toFixed(3)} hue50=${hueGot[1][0].toFixed(3)} hue100=${hueGot[2][0].toFixed(3)} (max |rendered-expect|=${maxLeakDelta.toFixed(4)})`);
    log(`LEAK PROOF fade @(${LEAKP},${FY}) base R=${baseF[0].toFixed(3)}, fade0 R=${f0[0].toFixed(3)}, fade100 R=${f100[0].toFixed(3)} (max |fade-expect|=${maxFadeDelta.toFixed(4)})`);
    log(`LEAK FILTER: ${leakOk ? 'PASS' : 'FAIL'} -- committed textures drive the leak (pixels-match:${maxLeakDelta < 0.04}, fade-kill:${maxFadeDelta < 0.04}, hue-moves:${hueMoves})`);

    // 12) EXPORT DOWNSCALE PROOF (case #5 -- "export presets wreck resolution").
    // Research: IG/FB preset VALUES are correct (1080/2048 = display caps, JPEG
    // 92%). The real resolution-wrecker was exportImage's SINGLE bilinear leap
    // (e.g. 60MP -> 1080px in one interpolating step). Now a box-filter pyramid
    // halves with exact 2x2 area-averages until within 2x of the export size.
    // On a PERIOD-4 stripe synthetic (2px on/2px off), an 8x export is entirely
    // above Nyquist -> correct area-averaging gives a FLAT output whose linear
    // value (per channel) equals the SOURCE texture's linear mean. A phase-
    // dependent bilinear samples 0.05/0.45, not the true mix -> mean mismatches.
    const sbl = raw.blackLevel, swh = raw.whiteLevel;
    const sLin = (L: number) => Math.round(sbl + L * (swh - sbl));
    const scfa = raw.cfa6;
    const spat = new Uint16Array(2048 * 2048);
    for (let y = 0; y < 2048; y++) {
      for (let x = 0; x < 2048; x++) {
        spat[y * 2048 + x] = sLin(((x >> 1) % 2) === 0 ? 0.85 : 0.05);
      }
    }
    const stripeRaw = { width: 2048, height: 2048, effectiveWidth: 2048, effectiveHeight: 2048, leftMargin: 0, topMargin: 0, bayerData: spat, cfa6: scfa, blackLevel: sbl, whiteLevel: swh, colorMatrix: raw.colorMatrix, camXyz: raw.camXyz, asShotGains: raw.asShotGains ?? { r: 1, g: 1, b: 1 } } as never;
    pipe3.load(stripeRaw);
    pipe3.render(synOps as never);
    // Source linear per-channel means (rgba16float displayTexture, rows 0..15 --
    // the pattern is column-periodic, so a few rows represent the whole image).
    const dtex = (pipe3 as any).displayTexture as GPUTexture;
    const dBPR = Math.ceil((dtex.width * 8) / 256) * 256;
    const ROWS = 16;
    const dBuf = wbDev.createBuffer({ size: dBPR * ROWS, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const de = wbDev.createCommandEncoder();
    de.copyTextureToBuffer({ texture: dtex }, { buffer: dBuf, bytesPerRow: dBPR }, { width: dtex.width, height: ROWS });
    wbDev.queue.submit([de.finish()]);
    await dBuf.mapAsync(GPUMapMode.READ);
    const d8 = new Uint8Array(dBuf.getMappedRange());
    const sR = [0, 0, 0];
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < dtex.width; x++) {
        const o = y * dBPR + x * 8;
        sR[0] += HALF_LUT[d8[o] | (d8[o + 1] << 8)];
        sR[1] += HALF_LUT[d8[o + 2] | (d8[o + 3] << 8)];
        sR[2] += HALF_LUT[d8[o + 4] | (d8[o + 5] << 8)];
      }
    }
    dBuf.unmap(); dBuf.destroy();
    const srcMean = sR.map((v) => v / (dtex.width * ROWS));
    // 8x box export: flat, and each channel's linear value == the source mean.
    const bb = await pipe3.exportImage(synOps as never, { format: 'png', bitDepth: 8, longEdge: 256 });
    const bm = await createImageBitmap(bb);
    const cc = document.createElement('canvas'); cc.width = bm.width; cc.height = bm.height;
    const g2 = cc.getContext('2d')!; g2.drawImage(bm, 0, 0);
    const im = g2.getImageData(0, 0, bm.width, bm.height).data;
    const sMean = [0, 0, 0]; let lsum = 0, lsq = 0;
    const nn = bm.width * bm.height;
    for (let i = 0; i < nn; i++) {
      sMean[0] += im[i * 4]; sMean[1] += im[i * 4 + 1]; sMean[2] += im[i * 4 + 2];
      const l = (im[i * 4] + im[i * 4 + 1] + im[i * 4 + 2]) / 3;
      lsum += l; lsq += l * l;
    }
    const sm = sMean.map((v) => v / nn);
    const lmean = lsum / nn;
    const lstd = Math.sqrt(Math.max(0, lsq / nn - lmean * lmean));
    const toLin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    const outLin = sm.map(toLin);
    const meanOk = Math.abs(outLin[0] - srcMean[0]) < 0.02 && Math.abs(outLin[1] - srcMean[1]) < 0.02 && Math.abs(outLin[2] - srcMean[2]) < 0.02;
    const flatOk = lstd < 15; // period-4 above Nyquist at 8x -> averaged flat
    const downOk = meanOk && flatOk;
    log(`DOWNSCALE EXPORT 256x256 (8x): sRGB mean=${lmean.toFixed(1)} std=${lstd.toFixed(2)} outLin=[${outLin.map((v) => v.toFixed(3))}] srcLin=[${srcMean.map((v) => v.toFixed(3))}]`);
    log(`DOWNSCALE FILTER: ${downOk ? 'PASS' : 'FAIL'} -- box pyramid flattens above-Nyquist stripes at the source's true linear mean (meanOk:${meanOk}, flatOk:${flatOk} std=${lstd.toFixed(1)})`);
    // 14) FREEFORM CROP OFFSET PROOF (task #58 -- the drag frame). A freeform
    // crop {x,y,w,h} must sample the SOURCE AT THAT OFFSET, not a centered rect
    // of the same size. On a vertical-gradient raw (black top -> white bottom)
    // a crop pinned to the TOP band must export dark and one pinned to the
    // BOTTOM band bright; a centered fallback would make both mid-gray.
    const fbl = raw.blackLevel, fwh = raw.whiteLevel;
    const fLin = (L: number) => Math.round(fbl + L * (fwh - fbl));
    const fcfa = raw.cfa6;
    const grad = new Uint16Array(2048 * 2048);
    for (let y = 0; y < 2048; y++) {
      const L = y / 2047;
      for (let x = 0; x < 2048; x++) grad[y * 2048 + x] = fLin(L);
    }
    const gradRaw = { width: 2048, height: 2048, effectiveWidth: 2048, effectiveHeight: 2048, leftMargin: 0, topMargin: 0, bayerData: grad, cfa6: fcfa, blackLevel: fbl, whiteLevel: fwh, colorMatrix: raw.colorMatrix, camXyz: raw.camXyz, asShotGains: raw.asShotGains ?? { r: 1, g: 1, b: 1 } } as never;
    pipe3.load(gradRaw);
    pipe3.render(synOps as never);
    const fcrop = (y: number, h: number) => ({ kind: 'crop', aspect: 'original', rotate90: 0, angle: 0, x: 0.5, y, w: 1, h } as never);
    const gradMean = async (ops: unknown[]) => {
      pipe3.render(ops as never);
      const gb = await pipe3.exportImage(ops as never, { format: 'png', bitDepth: 8, longEdge: null });
      const gbm = await createImageBitmap(gb);
      const gc = document.createElement('canvas'); gc.width = gbm.width; gc.height = gbm.height;
      const gx = gc.getContext('2d')!; gx.drawImage(gbm, 0, 0);
      const gi = gx.getImageData(0, 0, gbm.width, gbm.height).data;
      let s = 0; const n = gbm.width * gbm.height;
      for (let i = 0; i < n; i++) s += (gi[i * 4] + gi[i * 4 + 1] + gi[i * 4 + 2]) / 3;
      return { mean: s / n, w: gbm.width, h: gbm.height };
    };
    const top = await gradMean([...synOps, fcrop(0.02, 0.04)]);
    const mid = await gradMean([...synOps, fcrop(0.5, 0.04)]);
    const bot = await gradMean([...synOps, fcrop(0.98, 0.04)]);
    const freeOk = top.w === 2048 && top.h >= 70 && top.h <= 95 && top.mean < 80 && bot.mean > 200 && bot.mean - top.mean > 150;
    log(`FREEFORM CROP: top-band ${top.w}x${top.h} mean=${top.mean.toFixed(1)} | centered ${mid.w}x${mid.h} mean=${mid.mean.toFixed(1)} | bottom-band ${bot.w}x${bot.h} mean=${bot.mean.toFixed(1)}`);
    log(`FREEFORM FILTER: ${freeOk ? 'PASS' : 'FAIL'} -- the drag rect samples its own offset (top-dark:${top.mean < 80}, bottom-bright:${bot.mean > 200}, offset-moves:${bot.mean - top.mean > 150})`);
  } catch (e) {
    log('SYNTH test failed: ' + (e as Error).message);
  }
  // ---- 13. CONTACT SHEET FOLLOWS THE CULL FILTER (logic proof) ----
  // The contact module's DOM isn't mountable headless (no FileSystem handles),
  // so this proves the exact function the module now renders with: the same
  // cull filter as the grid, 36 frames/sheet, roll order preserved.
  try {
    const cs = await import('./src/app/contactSheet');
    const F = (id: number, flag?: boolean, rating?: number): FileRecord => ({
      id, folderId: 1, path: `img${id}.cr3`, name: `img${id}.cr3`,
      handle: {} as FileSystemFileHandle, size: 0, lastModified: 0, flag, rating,
    });
    const roll = [F(1), F(2, false), F(3, true), F(4, undefined, 4), F(5, true, 2)];
    const N = { hideRejected: false, pickedOnly: false, minRating: 0 };
    const ids = (sheets: FileRecord[][]) => sheets[0].map((f) => f.id);
    const hideRej = ids(cs.buildContactSheets(roll, { ...N, hideRejected: true }));
    const picked = ids(cs.buildContactSheets(roll, { ...N, pickedOnly: true }));
    const minR = ids(cs.buildContactSheets(roll, { ...N, minRating: 3 }));
    const big = Array.from({ length: cs.CONTACT_SHEET_SIZE + 4 }, (_, i) => F(i + 1));
    const chunked = cs.buildContactSheets(big, N);
    const hideOk = JSON.stringify(hideRej) === JSON.stringify([1, 3, 4, 5]);
    const pickOk = JSON.stringify(picked) === JSON.stringify([3, 5]);
    const minOk = JSON.stringify(minR) === JSON.stringify([4]);
    const chunkOk = chunked.length === 2 && chunked[0].length === cs.CONTACT_SHEET_SIZE && chunked[1].length === 4;
    const cOk = hideOk && pickOk && minOk && chunkOk;
    log(`CONTACT SHEET cull: hideRejected→[${hideRej}] pickedOnly→[${picked}] minRating3→[${minR}] chunked ${chunked.length} sheets`);
    log(`CONTACT FILTER: ${cOk ? 'PASS' : 'FAIL'} -- sheet excludes the same frames the grid hides, 36/sheet, order preserved (hideRej:${hideOk}, picked:${pickOk}, minR:${minOk}, chunk:${chunkOk})`);
  } catch (e) {
    log('CONTACT test failed: ' + (e as Error).message);
  }
  log('DONE');
}

main().catch((e) => { out.textContent += '\nERR: ' + e.message + '\n' + (e.stack || ''); });
