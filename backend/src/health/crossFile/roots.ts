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

// Extensions we treat as genuine importable source modules — the only files
// confidently classified "dead" when unreachable. Everything else (no grammar,
// or a format routinely loaded by path/fs rather than `import`) falls to
// "uncertain" instead.
//
// `.mjs`/`.cjs` are intentionally EXCLUDED even though we parse them: in a
// TS-first project they're almost always build/dev tooling or runtime assets
// (templates, helper scripts) referenced by path — e.g. a `create-task-
// template.cjs` read via `fs.readFile`, which static import analysis can't
// see. Flagging those red is the unreliable case; "uncertain" grey is honest.
// Orphaned `.mjs` scripts are still surfaced (grey), just not confidently red.
export const RESOLVABLE_IMPORT_EXTS = new Set<string>([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.pyi',
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
  // Build/dev/CLI tooling under a scripts|tools dir runs via `node x.mjs`,
  // never imported by the app. Treat the whole dir as roots (their helpers
  // then resolve live transitively).
  if (/(^|\/)(scripts?|tools)\//.test(norm)) return true;

  const ext = path.extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  if (stem === 'index' || stem === 'main') return true;
  // Standalone process / CLI entry points spawned by path rather than
  // imported: `server.ts`, `terminal-server.ts`, `foo.worker.ts`, `cli.ts`.
  if (/(^|[-.])(server|worker|daemon|entry|cli)$/.test(stem)) return true;
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

// Dirs we never descend into when discovering package.json files.
const PKG_SKIP_DIRS = new Set<string>([
  '.git', '.idea', '.vscode', '.lattice', 'node_modules',
  'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.cache',
  '.venv', 'venv', '__pycache__', 'target', '.gradle', 'Pods', 'DerivedData',
]);
const PKG_MAX_DEPTH = 4;

// Resolve package.json entry points to in-tree source files. Reads every
// package.json in the tree (root + workspace packages, e.g. `backend/`,
// `frontend/`), each resolved against its own dir. Covers `main`/`module`/
// `source`/`types`/`bin`/`exports` plus file references inside `scripts`
// (`"dev": "node scripts/dev.mjs"` → that file is a root). Best-effort: many
// `main` fields point at build output not in the scan, but `module`/`source`
// and script/bin targets in TS-first projects land on real files. Async —
// used by the full scan; the watcher recomputes conventional roots cheaply
// and reuses the seeded set.
export async function readPackageJsonRoots(
  projectRoot: string,
  presentFiles: Set<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const pkgFiles = await findPackageJsons(projectRoot);

  await Promise.all(
    pkgFiles.map(async (pkgPath) => {
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      } catch {
        return;
      }
      const dir = path.dirname(pkgPath);

      // Explicit entry fields are always file paths → resolve unconditionally.
      const fieldSpecs: string[] = [];
      const add = (v: unknown) => {
        if (typeof v === 'string') fieldSpecs.push(v);
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
      collectExportTargets(json.exports, fieldSpecs);
      for (const spec of fieldSpecs) resolvePackageSpec(spec, dir, presentFiles, out, false);

      // Script commands: pull out only the path-ish / script-extension tokens
      // (`node`, `tsc`, `--flag` are skipped by the requirePathish filter).
      if (json.scripts && typeof json.scripts === 'object') {
        for (const cmd of Object.values(json.scripts as Record<string, unknown>)) {
          if (typeof cmd !== 'string') continue;
          for (const tok of cmd.split(/\s+/)) {
            resolvePackageSpec(tok, dir, presentFiles, out, true);
          }
        }
      }
    }),
  );
  return out;
}

function resolvePackageSpec(
  spec: string,
  dir: string,
  presentFiles: Set<string>,
  out: Set<string>,
  requirePathish: boolean,
): void {
  if (!spec) return;
  // For script tokens, only consider things that look like a file path —
  // a separator or a script extension — so bare command names don't
  // accidentally resolve against the package dir.
  if (
    requirePathish &&
    !/[\\/]/.test(spec) &&
    !/\.(mjs|cjs|jsx?|tsx?)$/.test(spec)
  ) {
    return;
  }
  const target = path.resolve(dir, spec);
  const hit = presentFiles.has(target) ? target : tryAllExtensions(target, presentFiles);
  if (hit) out.add(hit);
}

async function findPackageJsons(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > PKG_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subwalks: Promise<void>[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (PKG_SKIP_DIRS.has(e.name)) continue;
        subwalks.push(walk(path.join(dir, e.name), depth + 1));
      } else if (e.isFile() && e.name === 'package.json') {
        out.push(path.join(dir, e.name));
      }
    }
    await Promise.all(subwalks);
  }
  await walk(projectRoot, 0);
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
