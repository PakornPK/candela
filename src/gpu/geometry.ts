// CPU-side model for the Geometry op (geometry.wgsl) — LrC's Transform panel:
// vertical/horizontal keystone (perspective), rotate, aspect (anamorphic
// balance after a keystone), scale, and offset X/Y. Pure + unit-tested: the
// shader computes the same output→source homography per pixel, but the
// direction semantics (which way each slider warps) are verifiable here
// without a browser.
//
// Model: output (x,y) ∈ [-1,1]² maps to source via
//   u0 = x − ox,  v0 = y − oy            (offset)
//   u1 = u0·(1+ka),  v1 = v0·(1−ka)      (aspect: anamorphic balance)
//   u2 = s·(u1·cosA − v1·sinA)           (rotate −angle, then scale s=scale/100)
//   v2 = s·(u1·sinA + v1·cosA)
//   denom = 1 + hp·u2 + vp·v2            (perspective keystone)
//   srcU = u2/denom, srcV = v2/denom
// with hp = horizontal/100, vp = vertical/100. A positive Vertical pulls the
// bottom of the frame toward the source center -- the top samples wider
// source, i.e. the converging-verticals correction (top-wide trapezoid).
//
// ponytail: the exact LrC slider semantics are proprietary; this is the
// standard homography model (same family darktable/Hugin use) with directions
// and neutral-identity pinned by tests. No Upright auto-detection. Geometry
// does not auto-zoom to cover black wedges -- LrC's Transform leaves them and
// the Scale slider pushes them out.


export interface GeometryParams {
  vertical: number;   // -100..100, keystone about the horizontal axis
  horizontal: number; // -100..100, keystone about the vertical axis
  rotate: number;     // -45..45 degrees
  aspect: number;     // -100..100, anamorphic balance
  scale: number;      // 0..200, 100 = 1:1
  offsetX: number;    // -100..100 (fraction of half-frame width)
  offsetY: number;    // -100..100 (fraction of half-frame height)
}

export function isNeutralGeometry(p: GeometryParams): boolean {
  return (
    p.vertical === 0 && p.horizontal === 0 && p.rotate === 0 && p.aspect === 0 &&
    p.scale === 100 && p.offsetX === 0 && p.offsetY === 0
  );
}

// Output-space (u,v) ∈ [-1,1]² → source-space (srcU, srcV) ∈ [-1,1]².
export function geometryMap(p: GeometryParams, u: number, v: number): [number, number] {
  const a = (p.rotate * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const s = p.scale / 100;
  const ka = p.aspect / 100;
  const hp = p.horizontal / 100;
  const vp = p.vertical / 100;
  const ox = p.offsetX / 100;
  const oy = p.offsetY / 100;
  const u0 = u - ox;
  const v0 = v - oy;
  const u1 = u0 * (1 + ka);
  const v1 = v0 * (1 - ka);
  const u2 = s * (u1 * ca - v1 * sa);
  const v2 = s * (u1 * sa + v1 * ca);
  const denom = Math.max(1 + hp * u2 + vp * v2, 1e-3);
  return [u2 / denom, v2 / denom];
}

// Uniform layout matches the `Geometry` struct in geometry.wgsl (8 f32s).
export function packGeometry(p: GeometryParams): Float32Array {
  return new Float32Array([
    (p.rotate * Math.PI) / 180,
    p.scale / 100,
    p.aspect / 100,
    p.horizontal / 100,
    p.vertical / 100,
    p.offsetX / 100,
    p.offsetY / 100,
    0,
  ]);
}
