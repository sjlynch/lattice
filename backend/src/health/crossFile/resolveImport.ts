import path from 'node:path';
import type { ParsedAlias } from '../tsconfig.js';

// Resolve a module specifier (as written in `import "./foo"`) to an
// absolute file path within the scanned tree. Best-effort:
//
//   1. Strip query/fragment portions (handled by the import extractor before
//      this resolver in practice, but keep the resolver focused on filesystem
//      candidates)
//   2. Skip external packages (no leading `.` or `/`)
//   3. For relative paths, try common extensions and `index.*`
//
// This isn't a full module resolver — we don't read package.json — but it's
// accurate enough for fan-in/fan-out signals on well-organized projects.
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

// Python relative imports surface as e.g. `.foo` or `..foo.bar` (leading dots
// indicate parent packages; remaining text is the dotted sub-package). Translate
// them into ordinary fs-relative specs so the rest of the resolver treats them
// like any other relative path.
export function normalizePythonRelativeImport(spec: string): string {
  let dots = 0;
  while (dots < spec.length && spec[dots] === '.') dots++;
  if (dots === 0) return spec;

  const rest = spec.slice(dots).replace(/\./g, '/');
  // 1 dot → './rest' (current package); 2 → '../rest'; 3 → '../../rest'.
  const parents = '../'.repeat(Math.max(0, dots - 1));
  const combined = `${parents}${rest}`;
  if (!combined) return '.';
  return combined.startsWith('.') ? combined : `./${combined}`;
}

// Try a target absolute path with all the extensions / index-file fallbacks we'd
// accept for a real import. Returns the first match in `presentFiles`, or null if
// nothing landed.
export function tryAllExtensions(
  target: string,
  presentFiles: Set<string>,
): string | null {
  // 1. Exact path as written (already-extensioned imports: `.ts`, `.tsx`,
  //    `.css`, a real hand-written `.js`, …).
  if (presentFiles.has(target)) return target;

  // 2. JS-family specifier → TS source (NodeNext). Only when the literal above
  //    missed, so a genuine `.js` sibling still wins.
  const ext = path.extname(target);
  const remaps = JS_TO_TS_CANDIDATES[ext];
  if (remaps) {
    const stem = target.slice(0, target.length - ext.length);
    for (const r of remaps) {
      if (presentFiles.has(stem + r)) return stem + r;
    }
  }

  // 3. Extensionless specifier → append each known source extension.
  for (const e of RESOLVE_EXTS) {
    if (presentFiles.has(target + e)) return target + e;
  }

  // 4. Directory import → its index file.
  for (const indexFile of INDEX_FILES) {
    const candidate = path.join(target, indexFile);
    if (presentFiles.has(candidate)) return candidate;
  }
  return null;
}

// Try the import against a tsconfig path-alias map. Aliases are pre-sorted
// longest-prefix-first in tsconfig.ts so the first match is the most specific.
export function resolveByAlias(
  spec: string,
  aliases: readonly ParsedAlias[],
  presentFiles: Set<string>,
): string | null {
  for (const alias of aliases) {
    let tail: string | null = null;
    if (alias.isWildcard) {
      if (alias.prefix === '') {
        // baseUrl catch-all (or a `"*"` path): applies to BARE specifiers
        // only. Relative imports resolve against the importing file, never
        // baseUrl — letting this match them would wrongly bind `./types` to
        // `<baseUrl>/types`.
        if (isRelativeSpec(spec)) continue;
        tail = spec;
      } else if (spec.startsWith(alias.prefix)) {
        tail = spec.slice(alias.prefix.length);
      }
    } else if (spec === alias.prefix) {
      tail = '';
    }
    if (tail === null) continue;

    for (const sub of alias.substitutions) {
      const target = tail ? path.join(sub, tail) : sub;
      const hit = tryAllExtensions(target, presentFiles);
      if (hit) return hit;
    }
  }
  return null;
}

function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('\\');
}

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
