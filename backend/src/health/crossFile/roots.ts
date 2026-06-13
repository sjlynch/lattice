import fs from 'node:fs/promises';
import path from 'node:path';
import { tryAllExtensions } from './resolveImport.js';

// Entry-point ("root") detection for the dead-code / reachability pass.
//
// A file is dead only if it can't be reached by following import edges from
// any root. Raw `fanIn === 0` is the wrong signal — entry points (index.ts,
// main.tsx, server.ts, *.config.*, test files, package.json bin/module
// targets) legitimately have no importers, and dead *islands* (files imported
// only by other dead files) have a non-zero fan-in. Reachability-from-roots
// fixes both; this module decides the root set.

// Extensions whose imports we actually parse + resolve (see resolveImport.ts /
// the tree-sitter grammars wired in parser.ts). Only files in these languages
// can be confidently classified "dead" when unreachable — everything else has
// no outgoing edges we can trust, so an unreachable file there is "uncertain".
export const RESOLVABLE_IMPORT_EXTS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyi',
]);

// Filename/path-shape heuristics for an entry point. Pure (no fs) so the
// watcher can recompute it cheaply on every change. Kept deliberately narrow:
// a false "entry" only downgrades a node from green to neutral, but we'd
// rather not silence genuine dead code, so we don't guess at `app`/`cli`/etc.
export function isConventionalRoot(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  // Ambient declarations are never "called" but aren't dead code either.
  if (base.endsWith('.d.ts')) return true;
  // Test / spec files and anything under a tests-like directory are runtime
  // entry points (a runner loads them; nothing imports them).
  if (/\.(test|spec)\.[^.]+$/.test(base)) return true;
  const norm = filePath.replace(/\\/g, '/');
  if (/(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)(\/|$)/.test(norm)) return true;

  const ext = path.extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  if (stem === 'index' || stem === 'main' || stem === 'server') return true;
  // `vite.config.ts`, `jest.config.js`, plain `config.ts`, etc.
  if (stem === 'config' || stem.endsWith('.config')) return true;
  return false;
}

// Minimal glob → RegExp for the user-configurable `deadCodeEntryGlobs` escape
// hatch (framework magic: file-based routing, DI registries, plugin globs).
// Supports `**`, `*`, and `?`; matches against the project-relative path.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` also matches zero dirs
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesEntryGlob(
  filePath: string,
  projectRoot: string,
  globs: readonly string[],
): boolean {
  if (globs.length === 0) return false;
  const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return false;
  return globs.some((g) => globToRegExp(g).test(rel));
}

// Combine conventional roots + user globs + caller-supplied extra roots
// (typically package.json entry targets) into one set. Pure.
export function detectRoots(
  presentFiles: Iterable<string>,
  opts: {
    projectRoot: string;
    entryGlobs?: readonly string[];
    extraRoots?: Iterable<string>;
  },
): Set<string> {
  const globs = opts.entryGlobs ?? [];
  const roots = new Set<string>();
  for (const f of presentFiles) {
    if (isConventionalRoot(f) || matchesEntryGlob(f, opts.projectRoot, globs)) {
      roots.add(f);
    }
  }
  if (opts.extraRoots) {
    for (const r of opts.extraRoots) roots.add(r);
  }
  return roots;
}

// Resolve package.json entry fields to in-tree source files. Best-effort:
// most `main`/`bin` point at build output (dist/) that isn't in the scan, but
// `module`/`source` and source-pointing `bin`/`exports` in TS-first projects
// do land on real files. Async (reads disk) — used by the full scan only; the
// watcher recomputes conventional roots cheaply and reuses the seeded set.
export async function readPackageJsonRoots(
  projectRoot: string,
  presentFiles: Set<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return out;
  }

  const specs: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') specs.push(v);
  };
  add(json.main);
  add(json.module);
  add(json.source);
  add(json.types);
  add(json.typings);
  if (typeof json.bin === 'string') add(json.bin);
  else if (json.bin && typeof json.bin === 'object') {
    for (const v of Object.values(json.bin as Record<string, unknown>)) add(v);
  }
  collectExportTargets(json.exports, specs);

  for (const spec of specs) {
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue;
    const target = path.resolve(projectRoot, spec);
    const hit = presentFiles.has(target) ? target : tryAllExtensions(target, presentFiles);
    if (hit) out.add(hit);
  }
  return out;
}

// `exports` can be a string, a conditions object, or a subpath map nested
// arbitrarily. Pull every string leaf.
function collectExportTargets(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const v of node) collectExportTargets(v, out);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node as Record<string, unknown>)) {
      collectExportTargets(v, out);
    }
  }
}
