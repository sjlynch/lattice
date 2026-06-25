// Case-insensitive filesystem handling for import resolution.
//
// Windows and (by default) macOS use case-insensitive filesystems: the TS/JS
// runtime resolves `import './Helper.js'` to an on-disk `helper.ts` there, so
// the dead-code analyzer must too. `presentFiles` holds absolute paths in exact
// on-disk casing, so a verbatim `.has()` of a case-differing specifier misses,
// the edge is dropped, and the target is wrongly flagged dead. On these
// platforms we consult a case-folded index when the exact lookup misses.

export const CASE_INSENSITIVE_FS =
  process.platform === 'win32' || process.platform === 'darwin';

// Map of lowercased path → its canonical on-disk path, built once per
// `presentFiles` Set and memoized by Set identity (a single analysis pass reuses
// the same Set across every resolveImport call, so this is O(N) per pass rather
// than per import). WeakMap-keyed so it's collected with the Set; safe because
// `presentFiles` is immutable for the duration of a pass.
const caseFoldedIndexCache = new WeakMap<Set<string>, Map<string, string>>();

function caseFoldedIndex(presentFiles: Set<string>): Map<string, string> {
  let index = caseFoldedIndexCache.get(presentFiles);
  if (!index) {
    index = new Map();
    for (const f of presentFiles) {
      const key = f.toLowerCase();
      // First writer wins, so a deterministic canonical path is returned even on
      // the rare case-insensitive volume that holds two files differing only in
      // case (Set iteration order is insertion order = scan order).
      if (!index.has(key)) index.set(key, f);
    }
    caseFoldedIndexCache.set(presentFiles, index);
  }
  return index;
}

// Membership test for a single candidate path: exact case first (the fast,
// always-correct path), then — only on a case-insensitive filesystem — the
// case-folded index, returning the canonical on-disk casing so the recorded
// edge keys match the rest of the graph.
export function lookupPresent(
  candidate: string,
  presentFiles: Set<string>,
): string | null {
  if (presentFiles.has(candidate)) return candidate;
  if (!CASE_INSENSITIVE_FS) return null;
  return caseFoldedIndex(presentFiles).get(candidate.toLowerCase()) ?? null;
}
