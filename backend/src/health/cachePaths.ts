// Location + schema-version constants for the persistent per-file health
// cache. Kept apart from the cache class so the class expresses only load/
// get/set/delete/prune/save/flush state transitions, and the "where + which
// version" facts live in one place shared by the reader/writer (cacheFile.ts)
// and the class's load-time version check.

import path from 'node:path';

// Bump on schema changes — old caches are rejected on load when the
// version doesn't match, forcing re-analysis with the new pipeline.
// v3: import extraction now captures `export … from` re-exports and dynamic
// `import()`/`require()`, and the resolver maps NodeNext `.js` specifiers to
// their `.ts` sources — the cached `imports` arrays from v2 predate all three,
// so reuse would keep the dead-code graph disconnected.
// v4: Python import extraction records every name of `import a, b as c` and
// the `pkg.name` submodule candidates of `from pkg import name` (v3 kept only
// the first name / the bare package), and bare Python specs now resolve.
export const CACHE_VERSION = 4;

const CACHE_DIRNAME = '.lattice';
const CACHE_FILENAME = 'health-cache.json';

// Directory holding the cache file (`<project>/.lattice`). Broken out so the
// writer can `mkdir -p` it before the atomic write without re-deriving the join.
export function cacheDir(projectRoot: string): string {
  return path.join(projectRoot, CACHE_DIRNAME);
}

// The cache file itself (`<project>/.lattice/health-cache.json`). The scanner's
// HealthCache and the watcher's both target this one path — the reason the
// writer is atomic.
export function cachePath(projectRoot: string): string {
  return path.join(projectRoot, CACHE_DIRNAME, CACHE_FILENAME);
}
