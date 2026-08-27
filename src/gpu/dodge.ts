// CPU-side model for the Dodge & Burn op (dodge.wgsl). The mask is a signed
// density field painted with soft circular brush strokes: positive density =
// dodge (lighten), negative = burn (darken), and overlapping strokes cancel
// (LrC's brush behaves the same). One signed float accumulates smoothly while
// painting; history stores a compact Int8 quantization, and the GPU texture
// upload needs 128-neutral display bytes.
//
// Model: effect = exp2(ev * density) where ev = amount/25 (0..4 EV at 0..100).
// A stroke adds `sign * opacity * smoothstepFalloff` inside its radius, clamped
// to [-1, 1].
//
// ponytail: no soft-erase brush (painting Burn over Dodge cancels; a Clear
// button wipes the whole mask). No multiple brush layers -- one dodgeBurn op
// per photo. Mask is display-space: painted after a crop, so a LATER crop/
// geometry change does not re-project the mask (LrC does; acceptable for v1).
export interface DodgeBurnParams {
  amount: number;  // 0..100, brush strength magnitude -> 0..4 EV
  size: number;    // 1..100, brush radius as % of the mask's max dimension / 2
  opacity: number; // 1..100, stroke opacity
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
// stamps at radius/2 spacing so a fast drag paints a continuous band.
export function paintStroke(
  mask: Float32Array, w: number, h: number,
  x0: number, y0: number, x1: number, y1: number,
  radius: number, opacity: number, sign: 1 | -1,
): void {
  if (radius <= 0) return;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(radius / 2, 1)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    stamp(mask, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, opacity, sign);
  }
}

function stamp(
  mask: Float32Array, w: number, h: number,
  cx: number, cy: number, radius: number, opacity: number, sign: 1 | -1,
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
      mask[i] = Math.min(1, Math.max(-1, mask[i] + sign * opacity * falloff));
    }
  }
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

export function opToMask(op: { mask: Int8Array; maskW: number; maskH: number }): Float32Array {
  const out = new Float32Array(op.maskW * op.maskH);
  for (let i = 0; i < out.length; i++) {
    out[i] = op.mask[i] / 127;
  }
  return out;
}
