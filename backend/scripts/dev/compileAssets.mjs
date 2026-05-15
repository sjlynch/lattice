import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { inheritStdio, resolveRequired, runOnce } from './deps.mjs';

export const copyAssetsScript = fileURLToPath(new URL('../copy-assets.mjs', import.meta.url));

export function resolveTscBin() {
  return resolveRequired('typescript/lib/tsc.js');
}

export async function runInitialCompile(tscBin) {
  console.log('[lattice-backend] initial compile...');
  const initialCode = await runOnce(process.execPath, [tscBin], {
    stdio: 'inherit',
  });
  if (initialCode !== 0) {
    console.error(
      `[lattice-backend] initial tsc exited ${initialCode}. Fix type errors and retry.`,
    );
    process.exit(initialCode);
  }
}

export async function runInitialCopyAssets(script = copyAssetsScript) {
  const copyAssetsCode = await runOnce(process.execPath, [script], {
    stdio: 'inherit',
  });
  if (copyAssetsCode !== 0) {
    console.error(
      `[lattice-backend] copy-assets exited ${copyAssetsCode}. The backend would crash on boot — aborting.`,
    );
    process.exit(copyAssetsCode);
  }
}

export function copyAssetsBeforeRespawn(script = copyAssetsScript) {
  // Re-copy static assets first. If a merge while this session was up
  // introduced a new runtime asset (e.g. src/latticeApiDocs/LATTICE_API.template.md),
  // it isn't in dist/ yet; the next spawn would crash any module that
  // reads it at import time (terminal-server has hit this twice now).
  // Synchronous + cheap (a couple fs.copyFile calls in a child) so the
  // backend lifecycle can keep spawnBackend a sync function — callers store
  // the ChildProcess directly and call .kill() on it.
  try {
    const r = spawnSync(process.execPath, [script], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.warn(
        `[lattice-backend] copy-assets exited ${r.status} before respawn — proceeding anyway (dist may be incomplete).`,
      );
    }
  } catch (err) {
    console.warn('[lattice-backend] copy-assets threw before respawn (continuing):', err);
  }
}

export function startTscWatch(tscBin) {
  return spawn(process.execPath, [tscBin, '-w', '--preserveWatchOutput'], {
    stdio: inheritStdio,
  });
}
