import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const inheritStdio = ['inherit', 'inherit', 'inherit'];

export const REQUIRED_PKGS = [
  'typescript',
  'express',
  'cors',
  'ws',
  'node-pty',
  'ignore',
  'chokidar',
];

export function resolveRequired(name) {
  return require.resolve(name);
}

export function hasPkg(name) {
  try {
    resolveRequired(name);
    return true;
  } catch {
    return false;
  }
}

export function npmCmd() {
  // .cmd shim on Windows can't be spawned without a shell since Node 20.
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function runOnce(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, opts);
    c.on('exit', (code) => resolve(code ?? 0));
    c.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
  });
}

export async function selfHealDeps() {
  const missing = REQUIRED_PKGS.filter((p) => !hasPkg(p));
  if (missing.length === 0) return;

  console.log(
    `[lattice-backend] missing ${missing.length} dep(s) (${missing.join(', ')}) — running 'npm install' to repair...`,
  );
  const code = await runOnce(npmCmd(), ['install'], {
    stdio: inheritStdio,
    shell: process.platform === 'win32',
  });
  if (code !== 0) {
    console.error(
      `[lattice-backend] 'npm install' exited with ${code}. Resolve manually and retry.`,
    );
    process.exit(code);
  }
}
