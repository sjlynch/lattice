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

// tsc -w prints this line at the end of every successful compile, both
// for its initial compile and after any subsequent edit. We use it as
// the "tsc has settled" signal: until we've seen it at least once, any
// dist/ change is presumed to be tsc -w re-emitting files from its
// initial compile (which it does even when the on-disk dist is already
// current — bumps mtimes the dist watcher would otherwise treat as a
// real change). Letting that fire restarts the backend in the gap
// between "listening" and "ready," and the user's browser races into
// ECONNREFUSED → 502 → "stuck on scanning."
const TSC_SETTLED_PATTERN = /Watching for file changes/i;

export function startTscWatch(tscBin) {
  // Inherit stdin/stderr but PIPE stdout so we can sniff the settled
  // signal. We forward every line to the parent's stdout unchanged so
  // the user sees the same `[backend]` log stream as before.
  const child = spawn(process.execPath, [tscBin, '-w', '--preserveWatchOutput'], {
    stdio: ['inherit', 'pipe', 'inherit'],
  });
  child.tscSettledPromise = waitForTscSettled(child);
  return child;
}

function waitForTscSettled(child) {
  return new Promise((resolve) => {
    let resolved = false;
    let buf = '';
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      // Forward to parent stdout so the user keeps seeing tsc -w output.
      process.stdout.write(text);
      if (resolved) return;
      buf += text;
      if (TSC_SETTLED_PATTERN.test(buf)) finish();
      // Bound the buffered text — we only need recent lines, and a long
      // compile-error stream shouldn't accumulate megabytes here.
      if (buf.length > 16_384) buf = buf.slice(-4_096);
    });
    // If tsc -w dies before settling, unblock so the dev runner can
    // continue its shutdown path rather than waiting forever.
    child.on('exit', finish);
    child.on('error', finish);
  });
}
