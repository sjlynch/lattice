// Stdio entry point for the Lattice task-board MCP server.
//
// Launched by the HARNESS (Claude / Codex / Pi), not by the backend: the MCP
// catalog's `lattice` entry runs `<node> <this file>` with `LATTICE_API_URL` +
// `LATTICE_PROJECT` in the child env (injected per spawn by `mcp/registry.ts`,
// so one server process serves exactly one project). It is a short-lived,
// dependency-light process — it talks HTTP to the running backend and imports
// none of it.
//
// STDOUT IS THE PROTOCOL. A single stray `console.log` corrupts the JSON-RPC
// frame stream and the harness drops the server with a parse error, so the
// first thing we do is point the stdout-writing console methods at stderr.
// (The MCP SDK itself never writes to stdout outside the transport, but a
// future import here, or a Node deprecation warning routed through console,
// easily could.)
//
// `--controller` (or LATTICE_MCP_MODE=controller) starts the opt-in
// multi-instance controller instead (`createControllerServer.ts`): instances
// from LATTICE_INSTANCES / LATTICE_API_URL, LATTICE_PROJECT only a default.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLatticeControllerServer } from './createControllerServer.js';
import { createLatticeMcpServer } from './createServer.js';
import { parseInstanceConfig } from './instances.js';

console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = (...args: unknown[]) => console.error(...args);

function fail(message: string): never {
  console.error(`[lattice-mcp] ${message}`);
  process.exit(1);
}

function isControllerMode(): boolean {
  return (
    process.argv.slice(2).includes('--controller') ||
    process.env.LATTICE_MCP_MODE?.trim().toLowerCase() === 'controller'
  );
}

function controllerServer(): McpServer {
  const parsed = parseInstanceConfig(process.env);
  if ('error' in parsed) fail(parsed.error);
  return createLatticeControllerServer(parsed.config);
}

function pinnedServer(): McpServer {
  const apiUrl = process.env.LATTICE_API_URL?.trim();
  const project = process.env.LATTICE_PROJECT?.trim();
  // Both are set by the resolver at spawn time; missing means this process was
  // started by hand (or by a stale harness config). Exiting loudly beats
  // serving tools that would every one of them fail.
  if (!apiUrl) fail('LATTICE_API_URL is not set — cannot reach the Lattice backend.');
  if (!project) fail('LATTICE_PROJECT is not set — this server must be pinned to one project.');
  // Optional: present only for a task worktree's session (run/resume). Unlocks
  // `my_task` and the id-less `append_summary`; every other session omits it.
  const taskId = process.env.LATTICE_TASK_ID?.trim() || undefined;
  // Optional: set only for a session the user started — adds the Fleet tools.
  const fleet = process.env.LATTICE_FLEET?.trim() === '1';
  return createLatticeMcpServer({ apiUrl, project, taskId, fleet });
}

async function main(): Promise<void> {
  const server = isControllerMode() ? controllerServer() : pinnedServer();
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  fail(`failed to start: ${(err as Error).stack ?? String(err)}`);
});
