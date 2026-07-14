// Pi MCP control plane — public barrel over `piMcp/`.
//
// Unlike Claude/Codex (whose config is resolved in the backend and APPLIED in
// the terminal-server), Pi's mechanism is cwd-local files that the third-party
// `pi-mcp-adapter` auto-discovers: `<cwd>/.pi/mcp.json` (the enabled server
// set) + `<cwd>/.pi/extensions/lattice-mcp.ts` (the extension loader shim). Both
// must exist in the session cwd before Pi starts, so the BACKEND writes them at
// the spawn chokepoint (it has fs access and knows the cwd); only the secret env
// rides the wire to the pty. No command rewriting. See mcp/CLAUDE.md.

import { resolveManagedPiServers } from './mcp/registry.js';
import { installPiMcpShim } from './piMcp/shim.js';
import { writePiMcpConfig } from './piMcp/config.js';

export { ensurePiMcpInstalled, getPiMcpEntry } from './piMcp/ensure.js';
export { installPiMcpShim } from './piMcp/shim.js';
export { writePiMcpConfig, reconcilePiMcpDocument } from './piMcp/config.js';
export { renderPiMcpShim, PI_MCP_SHIM_FILENAME } from './piMcp/render.js';

// Prepare a Lattice-spawned Pi session's cwd for MCP: reconcile
// `<cwd>/.pi/mcp.json` to the currently-enabled server set (adding managed
// servers, stripping ones we previously managed that are now off), drop the
// extension loader shim when there's ≥1 server, and return the secret env the
// pty must carry (stdio secrets the extension inherits via process.env).
//
// Best-effort throughout: a resolve/write failure degrades to a plain Pi spawn
// and never blocks it. Returns `{}` (no secret env) on any failure or when
// nothing is enabled.
export async function applyPiMcpForSpawn(
  cwd: string,
  projectPath: string,
): Promise<Record<string, string>> {
  const resolved = await resolveManagedPiServers(projectPath);
  if (!resolved) return {};
  const { mcpServers, env } = resolved;
  // Reconcile the config even when empty — this is how disabling a previously
  // enabled server strips it back out of a reused cwd (e.g. the project root).
  await writePiMcpConfig(cwd, mcpServers).catch((err) => {
    console.warn(`[pi-mcp] failed to write .pi/mcp.json in ${cwd}: ${(err as Error).message}`);
  });
  // Only load the extension when there's something to serve.
  if (Object.keys(mcpServers).length > 0) {
    await installPiMcpShim({ dir: cwd }).catch((err) => {
      console.warn(`[pi-mcp] failed to install shim in ${cwd}: ${(err as Error).message}`);
    });
  }
  return env;
}
