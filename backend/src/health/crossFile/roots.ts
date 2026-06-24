import path from 'node:path';

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
export function globToRegExp(glob: string): RegExp {
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

// Precompile the user's `deadCodeEntryGlobs` to RegExp[] once, so the per-file
// matcher just runs `.test()` instead of rebuilding a RegExp per glob per file
// per cross-file pass (G×F constructions). Callers cache the result where the
// glob list is captured (the watcher's CrossFileAnalyzer + the scan).
export function compileEntryGlobs(globs: readonly string[]): RegExp[] {
  return globs.map(globToRegExp);
}

export function matchesEntryGlob(
  filePath: string,
  projectRoot: string,
  entryRegexps: readonly RegExp[],
): boolean {
  if (entryRegexps.length === 0) return false;
  const rel = path.relative(projectRoot, filePath).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return false;
  return entryRegexps.some((re) => re.test(rel));
}

// Combine conventional roots + user globs + caller-supplied extra roots
// (typically package.json entry targets) into one set. Pure. `entryRegexps`
// is the precompiled `deadCodeEntryGlobs` (see compileEntryGlobs).
export function detectRoots(
  presentFiles: Iterable<string>,
  opts: {
    projectRoot: string;
    entryRegexps?: readonly RegExp[];
    extraRoots?: Iterable<string>;
  },
): Set<string> {
  const entryRegexps = opts.entryRegexps ?? [];
  const roots = new Set<string>();
  for (const f of presentFiles) {
    if (isConventionalRoot(f) || matchesEntryGlob(f, opts.projectRoot, entryRegexps)) {
      roots.add(f);
    }
  }
  if (opts.extraRoots) {
    for (const r of opts.extraRoots) roots.add(r);
  }
  return roots;
}
