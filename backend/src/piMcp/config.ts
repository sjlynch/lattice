// `<cwd>/.pi/mcp.json` reconcile + atomic write for the Lattice-managed Pi MCP
// servers. Same reconcile discipline as `mcp/claudeInject.reconcileMcpServers`:
// we tag the servers Lattice manages (a sibling `__latticeManagedMcp` name list)
// so each spawn adds the currently-enabled ones and strips ones we previously
// added that are now disabled — leaving any server the user hand-added to their
// own `.pi/mcp.json` untouched. pi-mcp-adapter ignores unknown top-level keys
// (its schema strips them) and does not rewrite this file on plain startup, so
// the marker round-trips safely.

import path from 'node:path';
import fs from 'node:fs/promises';
import { runExclusive } from '../serializeWrites.js';
import { MANAGED_MCP_MARKER } from '../mcp/claudeInject.js';
import type { PiMcpServerConfig } from '../mcp/piServerConfig.js';

type PiMcpDocument = {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
};

// Pure reconcile: merge `managed` into `existing.mcpServers`, dropping servers
// this marker says WE previously added that are gone now. Returns the new doc,
// or `null` when there is nothing to do (no managed servers and no prior marker)
// so the caller can skip the write entirely. Exported for unit testing.
export function reconcilePiMcpDocument(
  existing: PiMcpDocument,
  managed: Record<string, PiMcpServerConfig>,
): PiMcpDocument | null {
  const prevRaw = existing[MANAGED_MCP_MARKER];
  const prevManaged: string[] = Array.isArray(prevRaw)
    ? (prevRaw.filter((n) => typeof n === 'string') as string[])
    : [];
  const names = Object.keys(managed);

  // Nothing to add and nothing we own to clean up → leave the file as-is.
  if (names.length === 0 && prevManaged.length === 0) return null;

  const servers: Record<string, unknown> = {
    ...(existing.mcpServers && typeof existing.mcpServers === 'object'
      ? existing.mcpServers
      : {}),
  };
  for (const name of prevManaged) {
    if (!(name in managed)) delete servers[name];
  }
  for (const [name, cfg] of Object.entries(managed)) servers[name] = cfg;

  const out: PiMcpDocument = { ...existing, mcpServers: servers };
  if (names.length > 0) out[MANAGED_MCP_MARKER] = names;
  else delete out[MANAGED_MCP_MARKER];
  return out;
}

// Reconcile-write `<cwd>/.pi/mcp.json`. Per-cwd serialized so concurrent spawns
// into the same cwd can't interleave; atomic temp→rename. A no-op when there is
// nothing managed and nothing previously-managed to strip.
export async function writePiMcpConfig(
  cwd: string,
  managed: Record<string, PiMcpServerConfig>,
): Promise<void> {
  const file = path.join(cwd, '.pi', 'mcp.json');
  await runExclusive(`piMcp:${cwd}`, async () => {
    let existing: PiMcpDocument = {};
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object') existing = parsed as PiMcpDocument;
    } catch {
      /* absent / unparseable → start fresh */
    }
    const next = reconcilePiMcpDocument(existing, managed);
    if (!next) return; // nothing to do
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.lattice-tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, file);
  });
}
