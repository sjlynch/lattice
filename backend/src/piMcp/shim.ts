// Drop the pi-mcp-adapter discovery shim into a session cwd's
// `.pi/extensions/`. Mirror of `piSubagents/shim.ts`: graceful no-op until the
// shared install resolves, idempotent (skips the write when contents match so a
// worktree reconcile doesn't dirty `git status`).

import path from 'node:path';
import fs from 'node:fs/promises';
import { getPiMcpEntry } from './ensure.js';
import { PI_MCP_SHIM_FILENAME, renderPiMcpShim } from './render.js';

export async function installPiMcpShim(args: { dir: string }): Promise<void> {
  const entry = getPiMcpEntry();
  if (!entry) return; // shared install not resolved yet — no MCP this session
  const extDir = path.join(args.dir, '.pi', 'extensions');
  const shimFile = path.join(extDir, PI_MCP_SHIM_FILENAME);
  const expected = renderPiMcpShim(entry);
  try {
    if ((await fs.readFile(shimFile, 'utf8')) === expected) return;
  } catch {
    /* absent — fall through to write */
  }
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(shimFile, expected, 'utf8');
  console.log(`[pi-mcp] installed mcp shim at ${shimFile}`);
}
