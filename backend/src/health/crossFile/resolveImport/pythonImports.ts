// Python import resolution: absolute dotted imports (below) and relative-import
// translation (`normalizePythonRelativeImport`). Python relative imports surface as e.g.
// `.foo` or `..foo.bar` (leading dots indicate parent packages; remaining text
// is the dotted sub-package). Translate them into ordinary fs-relative specs so
// the rest of the resolver treats them like any other relative path.

import path from 'node:path';
import { CASE_INSENSITIVE_FS, lookupPresent } from './caseFold.js';

const foldName = (name: string): string =>
  CASE_INSENSITIVE_FS ? name.toLowerCase() : name;

// Every name an absolute import's FIRST segment could match: each Python
// file's stem and every directory on its path. Memoized by Set identity like
// the case-fold index (the present-file Set is reused across a pass, and across
// content-only watcher passes).
const topLevelNamesCache = new WeakMap<Set<string>, Set<string>>();

function pythonTopLevelNames(presentFiles: Set<string>): Set<string> {
  let names = topLevelNamesCache.get(presentFiles);
  if (!names) {
    names = new Set();
    for (const f of presentFiles) {
      if (!f.endsWith('.py') && !f.endsWith('.pyi')) continue;
      const parts = f.split(/[\\/]/);
      const base = parts[parts.length - 1];
      names.add(foldName(base.slice(0, base.lastIndexOf('.'))));
      for (let i = 0; i < parts.length - 1; i++) names.add(foldName(parts[i]));
    }
    topLevelNamesCache.set(presentFiles, names);
  }
  return names;
}

// A plain dotted module path (`pkg.sub.mod`); anything else (a relative spec,
// stray punctuation) is not an absolute Python import.
const DOTTED_MODULE_RE = /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u;

// Absolute Python imports (`import pkg.mod`, `from pkg.mod import x`) resolve
// against sys.path, which for a project is its root, a `src/` layout dir, or
// the directory of the script being run — none of which the analyzer knows.
// Previously every such spec was treated like an npm package and dropped, so a
// Python codebase that imports by package path (the norm) had almost no edges
// and its modules read as dead. Approximate sys.path by trying each ancestor
// directory of the importing file, nearest first: `pkg/mod.py`, `.pyi`, or the
// package's `__init__`. Only files present in the scan can match, so a stdlib
// or site-packages import (`import os`) finds nothing and is dropped as
// before; a same-named project module would shadow it in Python too.
export function resolvePythonAbsoluteImport(
  fromFile: string,
  spec: string,
  presentFiles: Set<string>,
): string | null {
  if (!DOTTED_MODULE_RE.test(spec)) return null;
  const segments = spec.split('.');
  // Fast reject: most bare specs are stdlib / site-packages (`os`, `typing`)
  // and would otherwise walk every ancestor on every cross-file pass — which
  // the watcher reruns after each edit.
  if (!pythonTopLevelNames(presentFiles).has(foldName(segments[0]))) return null;
  const rel = segments.join(path.sep);
  let dir = path.dirname(fromFile);
  for (;;) {
    const base = path.join(dir, rel);
    for (const candidate of [
      `${base}.py`,
      `${base}.pyi`,
      path.join(base, '__init__.py'),
      path.join(base, '__init__.pyi'),
    ]) {
      const hit = lookupPresent(candidate, presentFiles);
      if (hit) return hit;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
