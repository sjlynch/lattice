// Extension / index-file candidate generation: given a target absolute path,
// try the extensions and `index.*` files a real import would resolve to.
// This is the filesystem-candidate core of the resolver, kept free of alias /
// Python / orchestration concerns.

import path from 'node:path';
import { lookupPresent } from './caseFold.js';

// JS/TS/Python first (the common case + correct precedence when a `./foo`
// has both a `.ts` and a sibling asset). The trailing asset/component
// extensions let an extensionless import of a non-code file still resolve to
// an edge, so the imported asset isn't mistaken for dead code. Imports that
// already carry an extension match exactly via `presentFiles.has(target)`
// before this list is consulted.
export const RESOLVE_EXTS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py',
  '.vue', '.svelte', '.json',
];
export const INDEX_FILES = [
  'index.ts',
  'index.tsx',
  'index.js',
  'index.jsx',
  'index.mjs',
  'index.cjs',
  '__init__.py',
];

// TypeScript NodeNext/ESM convention: an import specifier carries the *output*
// `.js`-family extension even though the file on disk is the `.ts` twin
// (`import './types.js'` → `types.ts`). Without this mapping every such edge is
// dropped — which on a `"module": "NodeNext"` backend is ~every internal
// import, disconnecting the whole subgraph and flagging it all dead. For each
// JS-family extension, try the TypeScript sources first, then the literal
// (covers genuine hand-written `.js` alongside `.ts`).
const JS_TO_TS_CANDIDATES: Record<string, readonly string[]> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.jsx'],
  '.mjs': ['.mts', '.mjs'],
  '.cjs': ['.cts', '.cjs'],
};

// Try a target absolute path with all the extensions / index-file fallbacks we'd
// accept for a real import. Returns the first match in `presentFiles` (in its
// canonical on-disk casing), or null if nothing landed.
export function tryAllExtensions(
  target: string,
  presentFiles: Set<string>,
): string | null {
  // 1. Exact path as written (already-extensioned imports: `.ts`, `.tsx`,
  //    `.css`, a real hand-written `.js`, …).
  const exact = lookupPresent(target, presentFiles);
  if (exact) return exact;

  // 2. JS-family specifier → TS source (NodeNext). Only when the literal above
  //    missed, so a genuine `.js` sibling still wins.
  const ext = path.extname(target);
  const remaps = JS_TO_TS_CANDIDATES[ext];
  if (remaps) {
    const stem = target.slice(0, target.length - ext.length);
    for (const r of remaps) {
      const hit = lookupPresent(stem + r, presentFiles);
      if (hit) return hit;
    }
  }

  // 3. Extensionless specifier → append each known source extension.
  for (const e of RESOLVE_EXTS) {
    const hit = lookupPresent(target + e, presentFiles);
    if (hit) return hit;
  }

  // 4. Directory import → its index file.
  for (const indexFile of INDEX_FILES) {
    const candidate = path.join(target, indexFile);
    const hit = lookupPresent(candidate, presentFiles);
    if (hit) return hit;
  }
  return null;
}
