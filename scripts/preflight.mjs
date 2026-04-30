#!/usr/bin/env node
//
// Lattice dev preflight.
//
// Cheap sanity check across root / backend / frontend that catches:
//   - missing or partially-installed node_modules
//   - missing .bin shims (vite, tsc, concurrently, etc.)
//
// On any failed check, runs `npm run install:all` to repair, then exits.
// On a healthy tree, exits in single-digit ms.
//
// Wired up as the first step of `npm run dev` so a wiped or corrupt
// install doesn't surface as an opaque "Cannot find module ..." stack
// trace at boot — instead the dev pipeline self-heals.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Critical packages per workspace. Trim deliberately — checking everything
// is overkill; we just need a representative set so partial installs are
// detected.
const CHECKS = [
  { dir: '.', name: 'root', pkgs: ['concurrently'] },
  {
    dir: 'backend',
    name: 'backend',
    pkgs: ['typescript', 'express', 'cors', 'ws', 'node-pty', 'ignore'],
  },
  {
    dir: 'frontend',
    name: 'frontend',
    pkgs: [
      'vite',
      'react',
      'react-dom',
      'three',
      '3d-force-graph',
      '@xterm/xterm',
      '@vitejs/plugin-react-swc',
    ],
  },
];

// Bin shims we need to spawn — npm sometimes leaves the package present
// but the .bin entry missing after a botched install (we hit this in
// practice). Catch that explicitly.
const BIN_CHECKS = [
  { dir: 'backend', bin: 'tsc' },
  { dir: 'frontend', bin: 'vite' },
];

function pkgRequire(dir) {
  // createRequire anchored at "<workspace>/package.json" so resolution
  // looks in <workspace>/node_modules.
  return createRequire(new URL(`./${dir}/package.json`, `file:///${ROOT.replace(/\\/g, '/')}/`));
}

function checkPkg(dir, name) {
  try {
    pkgRequire(dir).resolve(name);
    return null;
  } catch {
    return `${dir}/${name}`;
  }
}

function checkBin(dir, bin) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const p = path.join(ROOT, dir, 'node_modules', '.bin', `${bin}${ext}`);
  return existsSync(p) ? null : `${dir}/.bin/${bin}`;
}

const missing = [];
for (const { dir, pkgs } of CHECKS) {
  for (const p of pkgs) {
    const m = checkPkg(dir, p);
    if (m) missing.push(m);
  }
}
for (const { dir, bin } of BIN_CHECKS) {
  const m = checkBin(dir, bin);
  if (m) missing.push(m);
}

if (missing.length === 0) {
  process.exit(0);
}

console.log(
  `[lattice] preflight detected ${missing.length} missing item(s):\n` +
    missing.map((m) => `  - ${m}`).join('\n'),
);
console.log(`[lattice] running 'npm run install:all' to repair...`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCmd, ['run', 'install:all'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
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
