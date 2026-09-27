import { WB_NEUTRAL_KELVIN } from '../gpu/uniforms';
import type { Op, ProfileKind } from './types';

// Lightroom-style Sync with ABSOLUTE semantics (real LrC), carrying USER INTENT
// only: a target receives the source's value for a control when the source
// actually has a value for it, and keeps its own when it does not.
//
// Delta semantics were tried and are deliberately not coming back. They need a
// per-photo as-imported baseline, but createEditState() seeds history[0] as an
// empty op list -- that baseline never exists, so every delta silently fell
// back to the slider neutrals.
//
// Plain absolute was tried too, and it skewed colour on every target. Root
// cause: currentOpsFromSliders() emits `profile`, `exposure` and
// `whiteBalance` UNCONDITIONALLY, while every other kind is emitted only when
// non-neutral (the source says so: "The parametric tone op is emitted only
// when non-neutral", "Vignette is emitted only when the amount is non-zero").
// Across the project an op's PRESENCE is what means "the user expressed
// intent", and those three break the rule: an untouched photo still carries
// EV 0, the default profile and a whiteBalance op, which for a RAW is the
// camera's As-Shot white point. Copying all three onto every target overrode
// each target's own As-Shot WB -- the reported skew. So the three are intent-
// filtered here rather than by changing what currentOpsFromSliders emits; that
// emission is load-bearing for render and history.
//
// A whiteBalance op carrying `gains` is still As-Shot -- the camera's own white
// point, not a choice -- so it carries no intent and goes. That also keeps
// gains off the sync path entirely: applyOpsToSliders reads the gains branch
// first, so a target handed the source's gains would ignore the synced
// kelvin/tint completely.

// The ops sync may write onto a target: the source's ops minus the controls it
// never moved. Input order is preserved.
export function syncableOps(ops: Op[], defaultProfile: ProfileKind): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (op.kind === 'whiteBalance') {
      // Present gains = the camera's As-Shot point (wbTouched was false).
      if (op.gains) continue;
      // No gains, but sitting on the slider neutral: indistinguishable from
      // untouched, and every other kind treats neutral as no op.
      if (op.kelvin === WB_NEUTRAL_KELVIN && op.tint === 0) continue;
    } else if (op.kind === 'exposure') {
      if (op.ev === 0) continue;
    } else if (op.kind === 'profile') {
      if (op.profile === defaultProfile) continue;
    }
    // Every other kind: currentOpsFromSliders already emits it only when
    // non-neutral, so presence already means intent.
    out.push(op);
  }
  return out;
}
