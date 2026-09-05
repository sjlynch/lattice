// Where the compiled stdio entry point (`server.js`) lives, resolved relative
// to THIS module rather than to the process cwd or a hardcoded `dist/` path.
//
// Why it needs its own module: `mcp/catalog.ts` bakes the path into the
// `lattice` catalog entry's `args`, and that catalog is loaded from
// `dist/mcp/catalog.js` at runtime. A path relative to the catalog would have to
// know how deep it sits; `import.meta.url` on a file that is a SIBLING of the
// entry point does not. `tsc` mirrors `src/` into `dist/` one-for-one, so
// `dist/latticeMcp/entryPath.js` always has `dist/latticeMcp/server.js` next to
// it, whatever the caller's own depth.
//
// Under the test runner (tsx executing `src/` directly) this resolves to
// `src/latticeMcp/server.js`, which does not exist — that is fine and expected:
// nothing in the suite SPAWNS the server, it is driven in-process over
// `InMemoryTransport`. The path only has to be real in a `tsc`-emitted tree,
// which is the only tree a harness ever launches from.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function latticeMcpServerEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.js');
}
