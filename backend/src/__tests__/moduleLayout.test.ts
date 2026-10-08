// One convention for a backend domain's public surface: a root `x.ts` facade
// beside its `x/` folder (e.g. worktree.ts over worktree/). Before this, 33
// domains used that, four used `x/index.ts` instead, and six stacked both
// (`x.ts` re-exporting `x/index.ts`), so an agent could not tell which layer
// to import or edit. Folders without a facade are fine (callers import the
// module they need). Pins: no `index.ts` facades under backend/src (the root
// `index.ts` is the server entry point, not a facade).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

test('no index.ts facades: a domain facade is the root x.ts beside x/', () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'index.ts' && dir !== SRC) found.push(path.relative(SRC, p).split(path.sep).join('/'));
    }
  };
  walk(SRC);
  assert.deepEqual(found, [], 'move the facade to <folder>.ts beside the folder');
});
