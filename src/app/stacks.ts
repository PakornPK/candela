// Stacks (gap-analysis P1-2, LrC's stacks) — pure model, no DOM.
//
// LrC collapses bursts/brackets into one tile: the TOP photo plus a count
// badge, expandable in place, and Auto-Stack By Capture Time groups shots
// whose consecutive capture gap is within a threshold (0s..1h). Bursts are
// why the Fuji users this product targets — they shoot 15-frame bursts as a
// habit — need this before the grid is cullable.

export interface Stack {
  id: string;
  fileIds: number[]; // first member is the top of the stack (LrC's representative)
  collapsed: boolean;
}

// Minimal shape autoStack needs; FileRecord satisfies it structurally, so the
// caller can pass full records without the module depending on the catalog.
export interface StackableFile {
  id: number;
  dateTaken?: number;
}

let syntheticStackSeq = 0; // module-local; stack ids only need to be stable within a session's stack list

// LrC's "Auto-Stack By Capture Time": sort by capture time, then walk and
// merge whenever the gap to the PREVIOUS photo is <= gapSeconds (inclusive —
// a burst fired exactly on the threshold belongs together; the UI shows the
// threshold as "maximum time between photos").
//
// A file with no dateTaken is NEVER stacked: the alternative is to sort it by
// lastModified, but mtime is when the file was COPIED onto this disk — an
// imported archive shares one ingest date across a decade of shoots, so the
// fallback would glue unrelated days into one mega-stack. Skipping is the
// honest default until the EXIF pass fills dateTaken (a parallel agent).
export function autoStackByCaptureTime(files: StackableFile[], gapSeconds: number): Stack[] {
  const dated = files
    .filter((f) => f.dateTaken !== undefined)
    .slice() // never mutate the caller's array
    .sort((a, b) => (a.dateTaken as number) - (b.dateTaken as number));

  const gapMs = gapSeconds * 1000;
  const stacks: Stack[] = [];
  let current: number[] = [];
  let prevTime: number | undefined;

  const flush = () => {
    // LrC's Group Into Stack makes a stack of the selection even for one
    // photo, but Auto-Stack by time is about collapsing BURSTS — a lone
    // frame grouped alone just adds a meaningless badge to the grid.
    if (current.length >= 2) {
      stacks.push({ id: nextStackId(current), fileIds: current, collapsed: true });
    }
    current = [];
  };

  for (const f of dated) {
    const t = f.dateTaken as number;
    if (current.length > 0 && prevTime !== undefined && t - prevTime > gapMs) flush();
    current.push(f.id);
    prevTime = t;
  }
  flush();
  return stacks;
}

// Content-derived ids keep toggle/unstack/add idempotent across re-runs of
// auto-stack (same burst -> same id), so an open expanded stack survives a
// resync instead of silently collapsing.
function nextStackId(fileIds: number[]): string {
  return `auto-${fileIds[0]}-${fileIds[fileIds.length - 1]}-${fileIds.length}`;
}

// The render list for grid/filmstrip. Files appear in their original order;
// a collapsed stack contributes ONLY its top (first member, LrC's
// representative) at the position where the stack starts; an expanded stack
// contributes all members adjacently (LrC shows the group in one row block);
// unstacked files pass through untouched.
export function visibleFiles<T extends { id: number }>(files: T[], stacks: Stack[]): T[] {
  // Index files once (O(n)); a per-file indexOf here would make the grid's
  // hot render path quadratic on a 100k catalog.
  const byId = new Map<number, T>();
  for (const f of files) byId.set(f.id, f);

  const skip = new Set<number>();
  const insertAfter = new Map<number, number[]>(); // topId -> trailing members
  for (const s of stacks) {
    const present = s.fileIds.filter((id) => byId.has(id));
    if (present.length === 0) continue;
    const top = present[0];
    if (s.collapsed) {
      // Hide the rest; the badge (stackCountFor) shows how many.
      for (const id of present.slice(1)) skip.add(id);
    } else {
      // Expanded: bring members next to the top even if the catalog order
      // scattered them (a stack must read as a group).
      insertAfter.set(top, present.slice(1));
      for (const id of present.slice(1)) skip.add(id); // re-inserted after top
    }
  }

  const out: T[] = [];
  for (const f of files) {
    if (skip.has(f.id)) continue;
    const t = byId.get(f.id);
    out.push(t as T);
    const tail = insertAfter.get(f.id);
    if (tail) for (const id of tail) out.push(byId.get(id) as T);
  }
  return out;
}

// The count badge LrC shows on a collapsed stack — the FULL member count,
// 0 when the file is not in any stack (so the grid draws no badge).
export function stackCountFor(fileId: number, stacks: Stack[]): number {
  for (const s of stacks) {
    if (s.fileIds.includes(fileId)) return s.fileIds.length;
  }
  return 0;
}

// ---- immutable editors (each returns a NEW array; inputs untouched) --------

export function toggleStackCollapsed(stacks: Stack[], stackId: string): Stack[] {
  return stacks.map((s) => (s.id === stackId ? { ...s, collapsed: !s.collapsed } : s));
}

// Dissolve one stack; its files simply become ordinary grid members again.
export function unstack(stacks: Stack[], stackId: string): Stack[] {
  return stacks.filter((s) => s.id !== stackId);
}

// Add a file to a stack (LrC's "Into Stack" menu / stacking a straggler).
// The invariant: a photo lives in AT MOST ONE stack — so the file is first
// removed from any other stack, and an empty-or-single leftover stack is
// dropped rather than kept as a one-photo shell.
export function addToStack(stacks: Stack[], stackId: string, fileId: number): Stack[] {
  const target = stacks.find((s) => s.id === stackId);
  if (!target) return stacks; // unknown stack: a no-op beats inventing one
  if (target.fileIds.includes(fileId)) return stacks; // already in: idempotent

  const withoutElsewhere = stacks.map((s) => {
    if (s.id === stackId || !s.fileIds.includes(fileId)) return s;
    const rest = s.fileIds.filter((id) => id !== fileId);
    // LrC deletes a stack once its last photo leaves; a 1-photo "stack" only
    // adds a badge lie, so it is unstacked here too.
    return rest.length >= 2 ? { ...s, fileIds: rest } : null;
  });

  const next: Stack[] = [];
  for (const s of withoutElsewhere) {
    if (s === null) continue;
    if (s.id === stackId) {
      next.push({ ...s, fileIds: [...s.fileIds, fileId] });
    } else {
      next.push(s);
    }
  }
  return next;
}

// Explicit id for stacks the user builds by hand ("Group Into Stack"); the
// parent owns uniqueness across sessions, this just avoids collisions with
// auto-stack's content-derived ids.
export function makeStackId(): string {
  return `stack-${++syntheticStackSeq}`;
}
