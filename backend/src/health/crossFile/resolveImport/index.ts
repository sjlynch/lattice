// Import resolver: turn a module specifier (as written in `import "./foo"`) into
// an absolute file path within the scanned tree. Best-effort — this isn't a full
// module resolver (we don't read package.json) — but it's accurate enough for
// fan-in/fan-out signals on well-organized projects.
//
// This is the orchestration core. The focused pieces live in sibling modules and
// are re-exported here so `./resolveImport.js` stays a single import surface:
//   - caseFold.ts             — case-insensitive filesystem index + lookup
//   - extensionCandidates.ts  — RESOLVE_EXTS/INDEX_FILES + NodeNext .js→.ts remap
//                               (`tryAllExtensions`)
//   - pythonImports.ts        — Python relative-import (`.foo` / `..pkg`) translation
//   - aliasResolution.ts      — tsconfig path-alias resolution (`resolveByAlias`)
//
// Resolution order: Python-relative normalization (Python importers only) →
// tsconfig aliases → external-package bail → relative filesystem candidates.

import path from 'node:path';
import type { ParsedAlias } from '../../tsconfig.js';
import { tryAllExtensions } from './extensionCandidates.js';
import { isRelativeSpec, resolveByAlias } from './aliasResolution.js';
import { normalizePythonRelativeImport } from './pythonImports.js';

// Re-export the public surface so existing `./resolveImport.js` imports are
// unaffected by the split.
export { RESOLVE_EXTS, INDEX_FILES, tryAllExtensions } from './extensionCandidates.js';
export { resolveByAlias } from './aliasResolution.js';
export { normalizePythonRelativeImport } from './pythonImports.js';

export function resolveImport(
  fromFile: string,
  spec: string,
  presentFiles: Set<string>,
  aliases?: readonly ParsedAlias[],
): string | null {
  if (!spec) return null;

  const normalized = fromFile.endsWith('.py') || fromFile.endsWith('.pyi')
    ? normalizePythonRelativeImport(spec)
    : spec;

  // Path-alias check has to come BEFORE the "external package" bail because
  // aliased specs (like `@/components/Foo`) look identical to scoped npm
  // packages — only the alias map can tell them apart.
  if (aliases && aliases.length > 0) {
    const aliased = resolveByAlias(normalized, aliases, presentFiles);
    if (aliased) return aliased;
  }

  // External package — `react`, `lodash/fp`, etc. (Bare specifiers that a
  // baseUrl catch-all could resolve were already handled by the alias pass
  // above; anything still bare here is a real node_modules dependency.)
  if (!isRelativeSpec(normalized)) {
    return null;
  }

  const fromDir = path.dirname(fromFile);
  const target = path.resolve(fromDir, normalized);
  return tryAllExtensions(target, presentFiles);
}
