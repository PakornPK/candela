export interface PathRange {
  lower: string;
  upper: string;
}

// Bounds for an IDBKeyRange matching every path starting with `prefix` --
// e.g. prefix "day1/" matches "day1/a.cr3" and "day1/sub/b.cr3" but not
// "day10/a.cr3". '￿' (U+FFFF) is the highest UTF-16 code unit, so under
// standard UTF-16 code-unit string comparison appending it to the prefix
// gives an upper bound at or above every string that starts with that
// prefix.
//
// Caller contract: `prefix` must end in "/" (or be "" to match every
// path). The sibling-exclusion property above only holds with a trailing
// separator -- pathPrefixRange('day1') (no trailing slash) does NOT
// exclude "day10/photo.cr3", because nothing stops the character right
// after "day1" from being a digit that sorts below '￿'. Normalizing the
// slash isn't this function's job: it's a generic prefix-range utility,
// and the folder-path convention belongs to callers (see paths.test.ts).
export function pathPrefixRange(prefix: string): PathRange {
  return { lower: prefix, upper: `${prefix}￿` };
}
