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
import { atomicWriteFile } from '../claudeTrust.js';
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
//
// "Absent" and "unreadable" are NOT the same thing: only ENOENT starts a fresh
// document. A file that exists but cannot be read (EBUSY/EPERM/EACCES) or does
// not parse (mid-edit, a comment, a BOM) is the user's hand-written config at
// the project root — replacing it from scratch would destroy it. Warn and skip
// the write instead (same discipline as piModels/reconcile.ts's
// readExistingModelsJson); that spawn simply runs without the managed servers.
export async function writePiMcpConfig(
  cwd: string,
  managed: Record<string, PiMcpServerConfig>,
): Promise<void> {
  const file = path.join(cwd, '.pi', 'mcp.json');
  await runExclusive(`piMcp:${cwd}`, async () => {
    let existing: PiMcpDocument = {};
    let raw: string | null = null;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[pi-mcp] leaving ${file} untouched — could not read it:`, err);
        return;
      }
      // Genuinely absent → safe to create.
    }
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.warn(
          `[pi-mcp] leaving ${file} untouched — it exists but is not valid JSON ` +
            `(refusing to overwrite it):`,
          err,
        );
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`[pi-mcp] leaving ${file} untouched — it is not a JSON object.`);
        return;
      }
      existing = parsed as PiMcpDocument;
    }
    const next = reconcilePiMcpDocument(existing, managed);
    if (!next) return; // nothing to do
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify(next, null, 2));
  });
}
