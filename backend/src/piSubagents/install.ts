// `pi install … -l` execution for the shared Lattice-owned install. Shells the
// `pi` CLI once with cwd = the shared `installDir()` (see paths.ts) and maps the
// shared spawn result onto a resolve-on-exit-0 / reject-otherwise contract.

import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { PI_SUBAGENTS_SPEC } from './paths.js';

// `pi install -l` can take ~20s on a cold cache (it runs `npm install` for the
// package + ~130 transitive deps). Generous bound; it only happens once.
const PI_INSTALL_TIMEOUT_MS = 180_000;

export async function runPiInstall(cwd: string): Promise<void> {
  // shell:true so Windows resolves `pi` → `pi.cmd`; args are static constants
  // (no injection surface).
  const r = await spawnWithTimeout('pi', ['install', PI_SUBAGENTS_SPEC, '-l'], {
    cwd,
    shell: true,
    timeoutMs: PI_INSTALL_TIMEOUT_MS,
  });
  if (r.timedOut) {
    throw new Error(`pi install timed out after ${PI_INSTALL_TIMEOUT_MS}ms`);
  }
  if (r.error) throw r.error;
  if (r.code !== 0) {
    throw new Error(`pi install exited ${r.code}: ${r.stderr.slice(0, 500)}`);
  }
}
