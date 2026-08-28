// CPU-side model for the Dodge & Burn op (dodge.wgsl). The mask is a signed
// density field painted with soft circular brush strokes: positive density =
// dodge (lighten), negative = burn (darken), and overlapping strokes cancel
// (LrC's brush behaves the same). One signed float accumulates smoothly while
// painting; history stores a compact Int8 quantization, and the GPU texture
// upload needs 128-neutral display bytes.
//
// Model: effect = exp2(ev * density) where ev = amount/25 (0..4 EV at 0..100).
// A stroke adds `sign * smoothstepFalloff` inside its radius, clamped to
// [-1, 1]. `opacity` and `feather` are LIVE post-paint transforms of the
// painted density (effectiveMask at upload): opacity scales the whole mask
// (default 50 = neutral x1.0), feather blurs the edges. So sliding either
// right after painting visibly re-shapes the mark -- the LrC feel the user
// asked for, no re-painting.
//
// ponytail: no soft-erase brush (painting Burn over Dodge cancels; a Clear
// button wipes the whole mask). No multiple brush layers -- one dodgeBurn op
// per photo. Mask is display-space: painted after a crop, so a LATER crop/
// geometry change does not re-project the mask (LrC does; acceptable for v1).
export interface DodgeBurnParams {
  amount: number;  // 0..100, brush strength magnitude -> 0..4 EV
  size: number;    // 1..100, brush radius as % of the mask's max dimension / 2
  opacity: number; // 1..100, live mask gain: density *= opacity/50 (50 = neutral)
  feather: number; // 0..100, live edge softness: box-blur radius of the mask
}

export const DODGE_MASK_MAX = 1024;

// Mask resolution: cap the longest edge at 1024, keep the aspect. ~1 MP at
// 1 byte/texel on the GPU; 390 KB (Int8) per history op. Soft brush strokes
// don't need full-res pixels.
export function maskDims(w: number, h: number): [number, number] {
  const scale = Math.min(1, DODGE_MASK_MAX / Math.max(w, h));
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

export function isNeutralDodgeBurn(p: DodgeBurnParams): boolean {
  return p.amount === 0;
}

export function maskHasPaint(mask: Float32Array): boolean {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) return true;
  }
  return false;
}

export function packDodgeBurn(p: DodgeBurnParams): Float32Array {
  return new Float32Array([p.amount / 25, 0, 0, 0]);
}

// Paints a soft stroke from (x0,y0) to (x1,y1) in mask pixel space. Interpolates
// stamps at radius/2 spacing so a fast drag paints a continuous band. Paints the
// FULL soft falloff (no per-stroke opacity) -- opacity is a live gain applied at
// upload (effectiveMask), so sliding it after painting re-shapes the mark.
export function paintStroke(
  mask: Float32Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  radius: number, sign: 1 | -1,
): void {
  if (radius <= 0) return;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(radius / 2, 1)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stamp(mask, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, sign);
  }
}

function stamp(
  mask: Float32Array, w: number, h: number,
  cx: number, cy: number, radius: number, sign: 1 | -1,
): void {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h - 1, Math.ceil(cy + radius));
  const r2 = radius * radius;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const t = Math.sqrt(d2) / radius;
      const falloff = 1 - t * t * (3 - 2 * t); // 1 at center -> 0 at edge
      const i = y * w + x;
      mask[i] = Math.min(1, Math.max(-1, mask[i] + sign * falloff));
    }
  }
}

// Live post-paint mask transform, uploaded to the GPU (the painted mask is never
// mutated -- this is a pure copy). opacity scales density (50 = x1.0 neutral);
// feather box-blurs the mark's edge so its dark/light boundary softens. Runs in
// syncDodgeMaskToGPU on every paint AND every opacity/feather drag, so both
// sliders visibly re-shape an already-painted mark. Feather radius = % of the
// mask's max edge / 25 (feather 100 on a 1024 mask -> r=41).
export function effectiveMask(
  mask: Float32Array, w: number, h: number,
  opacity: number, feather: number,
): Float32Array {
  const gain = opacity / 50;
  let out: Float32Array = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = Math.min(1, Math.max(-1, mask[i] * gain));
  }
  if (feather > 0 && w > 1 && h > 1) {
    const r = Math.max(1, Math.round((feather / 100) * Math.max(w, h) / 25));
    // ponytail: two box passes approximate a gaussian; fine for a soft edge,
    // not a real gaussian. More passes if the edge ever needs a longer tail.
    for (let pass = 0; pass < 2; pass++) {
      out = boxBlur1D(out, w, h, r, true);
      out = boxBlur1D(out, w, h, r, false);
    }
  }
  return out;
}

// Separable box blur (sliding window, clamped edges so border paint is kept).
function boxBlur1D(src: Float32Array, w: number, h: number, r: number, horizontal: boolean): Float32Array {
  const dst = new Float32Array(src.length);
  const n = horizontal ? w : h;
  const clampI = (i: number) => (horizontal ? Math.min(w - 1, Math.max(0, i)) : Math.min(h - 1, Math.max(0, i)));
  // Index = line*w + inner. Horizontal: line=row, inner=col. Vertical:
  // line=col, inner=row -> row*w + col.
  const at = (line: number, i: number) => src[horizontal ? line * w + i : i * w + line];
  const put = (line: number, i: number, v: number) => { dst[horizontal ? line * w + i : i * w + line] = v; };
  const win = 2 * r + 1;
  for (let line = 0; line < (horizontal ? h : w); line++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += at(line, clampI(i));
    for (let i = 0; i < n; i++) {
      put(line, i, sum / win);
      sum += at(line, clampI(i + r + 1)) - at(line, clampI(i - r));
    }
  }
  return dst;
}

// GPU upload bytes: r8unorm, 128 = neutral (density 0). Sampled back as
// texel.r * 2 - 1 in dodge.wgsl.
export function maskToBytes(mask: Float32Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    bytes[i] = 128 + Math.round(Math.min(1, Math.max(-1, mask[i])) * 127);
  }
  return bytes;
}

// History storage: symmetric Int8 quantization (density * 127), ~390 KB at the
// 1024 cap. Round-trips through opToMask with <= 1/127 error.
export function maskToOp(mask: Float32Array): Int8Array {
  const out = new Int8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    out[i] = Math.round(Math.min(1, Math.max(-1, mask[i])) * 127);
  }
  return out;
}

// Brush overlay pixels (RGBA) for the DOM canvas above the WebGPU canvas:
// LrC-style mask while brushing. Drawn from the CPU-authoritative paintMask
// (the GPU texture is just its mirror), so no readback is needed.
// alpha = |density| (0..1); the color is the overlay swatch (user-adjustable,
// red by default). The mask is signed (dodge vs burn) but the overlay is one
// color -- LrC shows the same overlay color either way.
export function maskToOverlay(mask: Float32Array, color: [number, number, number] = [255, 0, 60]): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4;
    const a = Math.min(1, Math.abs(mask[i]));
    out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2]; out[o + 3] = Math.round(a * 255);
  }
  return out;
}

export function opToMask(op: { mask: Int8Array; maskW: number; maskH: number }): Float32Array {
  const out = new Float32Array(op.maskW * op.maskH);
  for (let i = 0; i < out.length; i++) {
    out[i] = op.mask[i] / 127;
  }
  return out;
}
