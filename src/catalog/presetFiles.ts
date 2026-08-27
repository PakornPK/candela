import type { Op } from './types';
import { isValidOp } from './editsStore';

// A preset as a shareable data file (CLAUDE.md roadmap: "presets are data
// rather than code"). The file is pure JSON -- an op chain + a name -- so a
// preset is a flat text file you can share, back up, or hand to another user,
// not a plugin or a binary blob. The `candelaPreset` version field lets a
// future schema change be detected on import instead of silently mis-reading
// an old file.
export const PRESET_FILE_VERSION = 1;
// Files open with `.candela-preset.json`; import filters on `.json`.
export const PRESET_FILE_EXT = '.candela-preset.json';

export interface PresetFile {
  candelaPreset: number;
  name: string;
  ops: Op[];
}

// dodgeBurn's brush mask is an Int8Array. JSON.stringify emits a typed array
// as an object {"0":128,...}, which isValidOp's `mask instanceof Int8Array`
// check rejects on import -- so the file form carries masks as plain byte
// arrays instead. These two helpers are the only places that conversion
// happens; both the serialize side and the parse side must stay in sync.
function maskToJson(op: Op): unknown {
  if (op.kind !== 'dodgeBurn') return op;
  return { ...op, mask: Array.from(op.mask) };
}

function maskFromJson(op: unknown): unknown {
  if (typeof op !== 'object' || op === null) return op;
  const o = op as { kind?: unknown; mask?: unknown };
  if (o.kind === 'dodgeBurn' && Array.isArray(o.mask)) {
    return { ...(op as Record<string, unknown>), mask: new Int8Array(o.mask as ArrayLike<number>) };
  }
  return op;
}

export function serializePreset(name: string, ops: Op[]): string {
  return JSON.stringify({ candelaPreset: PRESET_FILE_VERSION, name, ops: ops.map(maskToJson) }, null, 2);
}

// Parses + validates an imported preset file. Throws on anything that isn't a
// recognizable preset (bad JSON, wrong version, missing name, ops that fail
// isValidOp) so the caller can show one clean "not a valid preset file" error
// instead of half-loading a corrupt file. fallbackName supplies the name when
// the file carries none (e.g. someone hand-edited it).
export function parsePreset(json: string, fallbackName?: string): PresetFile {
  const parsed: unknown = JSON.parse(json); // throws on malformed JSON
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  const file = parsed as { candelaPreset?: unknown; name?: unknown; ops?: unknown };
  if (file.candelaPreset !== PRESET_FILE_VERSION) {
    throw new Error(`unsupported version ${String(file.candelaPreset)}`);
  }
  const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : (fallbackName ?? '');
  if (!name) throw new Error('missing name');
  if (!Array.isArray(file.ops)) throw new Error('missing ops array');
  const ops = file.ops.map(maskFromJson);
  if (!ops.every(isValidOp)) throw new Error('ops fail validation');
  return { candelaPreset: PRESET_FILE_VERSION, name, ops };
}
