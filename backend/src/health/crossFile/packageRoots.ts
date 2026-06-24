import fs from 'node:fs/promises';
import path from 'node:path';
import { IGNORE_DIR_NAMES } from '../constants.js';
import { walkSourceTree } from '../walkTree.js';
import { tryAllExtensions } from './resolveImport.js';

// Package.json entry-point resolution for the dead-code / reachability pass —
// the async, filesystem-walking half of root detection (the pure, fs-free
// filename heuristics live in `./roots.js`). Used only by the full scan; the
// watcher's hot path recomputes the cheap conventional roots and reuses the
// seeded package-json set rather than re-walking the tree on every tick.

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

// Find every package.json in the tree via the shared bounded walker
// (health/walkTree.ts) with the canonical skip-dir set.
async function findPackageJsons(projectRoot: string): Promise<string[]> {
  const out: string[] = [];
  await walkSourceTree(projectRoot, {
    maxDepth: PKG_MAX_DEPTH,
    skipDirs: IGNORE_DIR_NAMES,
    onFile: (filePath, name) => {
      if (name === 'package.json') out.push(filePath);
    },
  });
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
