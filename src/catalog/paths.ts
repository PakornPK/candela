export interface PathRange {
  lower: string;
  upper: string;
}

// Bounds for an IDBKeyRange matching every path starting with `prefix` --
// e.g. prefix "day1/" matches "day1/a.cr3" and "day1/sub/b.cr3" but not
// "day10/a.cr3". '￿' is the highest UTF-16 code unit IndexedDB will
// compare against, so appending it to the prefix gives an upper bound
// above every string that starts with that prefix.
export function pathPrefixRange(prefix: string): PathRange {
  return { lower: prefix, upper: `${prefix}￿` };
}
