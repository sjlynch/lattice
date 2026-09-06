// Declared-vs-installed dependency check, shared by the root preflight
// (`scripts/preflight.mjs`) and the backend dev runner
// (`backend/scripts/dev/deps.mjs`).
//
// Why this exists: both self-heal checks used to probe a hand-picked SAMPLE
// of packages ("is express there? is vite there?"). That catches a wiped or
// half-installed node_modules, but not the far more common case — a
// `git pull` that adds a dependency to a workspace's package.json. The
// sample still resolves, preflight reports "healthy", and the boot dies in
// `tsc` with `Cannot find module '@modelcontextprotocol/sdk/...'` (seen
// 2026-09-06 when the first-party MCP server landed). So this reads what
// each workspace actually declares and compares it with what is on disk:
//
//   - every entry in `dependencies` + `devDependencies` must have a
//     `node_modules/<name>/package.json`; and
//   - when the committed package-lock.json pins a version for it, the
//     installed version must match exactly — so a pulled bump (a major
//     upgrade that changes the API) also triggers a reinstall, not only an
//     addition.
//
// Presence is judged by the package's own package.json, NOT `require.resolve`:
// a package whose `exports` map has no "." entry (the MCP SDK is one) and a
// types-only package (`@types/*`) both throw from resolve even when they are
// correctly installed.
//
// `optionalDependencies` are deliberately not checked — they may legitimately
// be absent on this platform.

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ name: string, reason: 'missing' }
 *   | { name: string, reason: 'version', expected: string, installed: string }} StaleDep
 */

/** Direct dependency names a manifest declares (deps + devDeps, deduped). */
export function declaredDeps(manifest) {
  const names = new Set();
  for (const key of ['dependencies', 'devDependencies']) {
    const block = manifest && typeof manifest === 'object' ? manifest[key] : null;
    if (!block || typeof block !== 'object') continue;
    for (const name of Object.keys(block)) names.add(name);
  }
  return [...names];
}

/**
 * The version the lockfile resolved a direct dependency to, or `null` when
 * the lock does not pin one (no lockfile, no entry, or a `file:`/workspace
 * link — which has no version worth comparing).
 */
export function lockedVersion(lock, name) {
  if (!lock || typeof lock !== 'object') return null;
  // lockfileVersion 2/3: a flat `packages` map keyed by install path. A
  // direct dependency of the root always lives at the top level.
  const entry = lock.packages?.[`node_modules/${name}`];
  if (entry && typeof entry === 'object') {
    if (entry.link) return null;
    return typeof entry.version === 'string' ? entry.version : null;
  }
  // lockfileVersion 1: a nested `dependencies` tree; top level = direct deps.
  const legacy = lock.dependencies?.[name];
  return legacy && typeof legacy.version === 'string' ? legacy.version : null;
}

/**
 * Pure core: which declared deps are absent or at the wrong version.
 * `installedVersion(name)` returns the on-disk version, or `null` when the
 * package is not installed at all.
 */
export function findStaleDeps({ manifest, lock, installedVersion }) {
  /** @type {StaleDep[]} */
  const stale = [];
  for (const name of declaredDeps(manifest)) {
    const installed = installedVersion(name);
    if (installed == null) {
      stale.push({ name, reason: 'missing' });
      continue;
    }
    const expected = lockedVersion(lock, name);
    if (expected != null && installed !== expected) {
      stale.push({ name, reason: 'version', expected, installed });
    }
  }
  return stale;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `installedVersion` over a real `<dir>/node_modules` tree. */
export function installedVersionIn(dir) {
  return (name) => {
    const pkg = readJson(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'));
    if (!pkg || typeof pkg !== 'object') return null;
    return typeof pkg.version === 'string' ? pkg.version : '';
  };
}

/**
 * Check one npm workspace directory (holding package.json, optionally
 * package-lock.json, and node_modules/). A directory with no readable
 * package.json has nothing declared and yields `[]`.
 */
export function checkWorkspaceDeps(dir) {
  const manifest = readJson(path.join(dir, 'package.json'));
  if (!manifest) return [];
  const lock = readJson(path.join(dir, 'package-lock.json'));
  return findStaleDeps({ manifest, lock, installedVersion: installedVersionIn(dir) });
}

/** One human-readable line per stale dep, e.g. `backend/zod (not installed)`. */
export function describeStaleDep(dep, prefix = '') {
  const label = prefix ? `${prefix}/${dep.name}` : dep.name;
  return dep.reason === 'missing'
    ? `${label} (not installed)`
    : `${label} (installed ${dep.installed || '?'}, lockfile wants ${dep.expected})`;
}
