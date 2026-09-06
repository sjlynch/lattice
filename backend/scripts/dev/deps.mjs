import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { checkWorkspaceDeps, describeStaleDep } from '../../../scripts/depsCheck.mjs';

const require = createRequire(import.meta.url);

// <repo>/backend — this file is backend/scripts/dev/deps.mjs.
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const inheritStdio = ['inherit', 'inherit', 'inherit'];

export function resolveRequired(name) {
  return require.resolve(name);
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

// Second self-heal layer behind the root `scripts/preflight.mjs`, for when
// this runner is started on its own. Same rule as preflight: every dep that
// backend/package.json declares must be installed, at the version
// package-lock.json pins — not a hand-picked sample, which is how a pulled
// `@modelcontextprotocol/sdk` + `zod` addition once sailed past the check
// and died in the initial `tsc` instead.
export async function selfHealDeps() {
  const stale = checkWorkspaceDeps(BACKEND_DIR);
  if (stale.length === 0) return;

  console.log(
    `[lattice-backend] ${stale.length} dep(s) out of step with package.json / package-lock.json ` +
      `(${stale.map((d) => describeStaleDep(d)).join(', ')}) — running 'npm install' to repair...`,
  );
  // One constant command string on Windows (where npm is a .cmd shim that
  // needs a shell) — args + shell:true trips Node's DEP0190 warning.
  const win = process.platform === 'win32';
  const code = await runOnce(win ? 'npm install' : npmCmd(), win ? [] : ['install'], {
    cwd: BACKEND_DIR,
    stdio: inheritStdio,
    shell: win,
  });
  if (code !== 0) {
    console.error(
      `[lattice-backend] 'npm install' exited with ${code}. Resolve manually and retry.`,
    );
    process.exit(code);
  }
}
