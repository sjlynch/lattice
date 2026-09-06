#!/usr/bin/env node
//
// Lattice dev preflight.
//
// Cheap sanity check across root / backend / frontend that catches:
//   - a dependency that package.json declares but node_modules lacks —
//     the usual aftermath of a `git pull` that added a package
//   - a dependency installed at a different version than the committed
//     package-lock.json pins — a pulled bump
//   - a missing or partially-installed node_modules
//   - missing .bin shims (tsc, vite) that a botched install can leave out
//
// On any failed check, runs `npm run install:all` to repair, then exits.
// On a healthy tree it exits in a few ms.
//
// Wired up as the first step of `npm run dev` so a stale or corrupt install
// doesn't surface as an opaque "Cannot find module ..." stack trace at boot —
// instead the dev pipeline self-heals. The declared-vs-installed comparison
// lives in `depsCheck.mjs` (shared with the backend's own self-heal); see the
// header there for why it reads the manifests instead of probing a sample.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkWorkspaceDeps, describeStaleDep } from './depsCheck.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every npm workspace with its own package.json + node_modules. Each is
// checked against what IT declares, so a new dependency landing in any of
// them is picked up without editing this list.
const WORKSPACES = [
  { dir: '.', name: 'root' },
  { dir: 'backend', name: 'backend' },
  { dir: 'frontend', name: 'frontend' },
];

// Bin shims we need to spawn — npm sometimes leaves the package present
// but the .bin entry missing after a botched install (we hit this in
// practice). Catch that explicitly.
const BIN_CHECKS = [
  { dir: 'backend', bin: 'tsc' },
  { dir: 'frontend', bin: 'vite' },
];

function checkBin(dir, bin) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const p = path.join(ROOT, dir, 'node_modules', '.bin', `${bin}${ext}`);
  return existsSync(p) ? null : `${dir}/.bin/${bin} (shim missing)`;
}

const problems = [];
for (const { dir, name } of WORKSPACES) {
  for (const dep of checkWorkspaceDeps(path.join(ROOT, dir))) {
    problems.push(describeStaleDep(dep, name));
  }
}
for (const { dir, bin } of BIN_CHECKS) {
  const m = checkBin(dir, bin);
  if (m) problems.push(m);
}

if (problems.length === 0) {
  process.exit(0);
}

console.log(
  `[lattice] preflight: ${problems.length} dependency item(s) out of step with the checked-in package.json / package-lock.json` +
    ` (a fresh pull that added or bumped a package, or a partial install):\n` +
    problems.map((m) => `  - ${m}`).join('\n'),
);
console.log(`[lattice] running 'npm run install:all' to bring node_modules up to date...`);

// On Windows npm is a .cmd shim, which Node can only launch through a shell.
// Hand the shell ONE constant command string rather than args + shell:true —
// that combination trips Node's DEP0190 warning on every repair.
const win = process.platform === 'win32';
const child = spawn(win ? 'npm run install:all' : 'npm', win ? [] : ['run', 'install:all'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: win,
});
child.on('exit', (code) => {
  if (code !== 0) {
    console.error(
      `[lattice] 'npm run install:all' exited ${code}. Resolve manually and retry.`,
    );
  }
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  console.error('[lattice] failed to spawn npm:', err);
  process.exit(1);
});
