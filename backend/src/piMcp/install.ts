// `pi install npm:pi-mcp-adapter -l` execution for the shared Lattice-owned
// install. Mirror of `piSubagents/install.ts`.

import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { PI_MCP_SPEC } from './paths.js';

// `pi install -l` runs `npm install` for the package + its deps; generous bound
// (it only happens once).
const PI_INSTALL_TIMEOUT_MS = 180_000;

export async function runPiMcpInstall(cwd: string): Promise<void> {
  // shell:true so Windows resolves `pi` → `pi.cmd`; args are static constants
  // (no injection surface).
  const r = await spawnWithTimeout('pi', ['install', PI_MCP_SPEC, '-l'], {
    cwd,
    shell: true,
    timeoutMs: PI_INSTALL_TIMEOUT_MS,
  });
  if (r.timedOut) {
    throw new Error(`pi install (mcp) timed out after ${PI_INSTALL_TIMEOUT_MS}ms`);
  }
  if (r.error) throw r.error;
  if (r.code !== 0) {
    throw new Error(`pi install (mcp) exited ${r.code}: ${r.stderr.slice(0, 500)}`);
  }
}
