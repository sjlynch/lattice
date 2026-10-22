// `plan_usage` — the machine's Claude and Codex (ChatGPT) subscription usage,
// from GET /api/plan-usage, so an orchestrating agent can check its budget
// before launching many or long runs. Machine-global: the pinned server sends
// its usual `project=` (ignored by the route); the controller takes `instance`
// to read another Lattice's machine. Not offered in task worktrees.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LatticeClient } from '../client.js';
import { toToolResult, type ToolResult } from '../toolResult.js';

const DESCRIPTION =
  'Claude and Codex (ChatGPT) subscription usage on this machine: % used per rate-limit ' +
  'window (Claude 5-hour session + week; Codex its windows) and when each resets, plus ' +
  'notes such as extra usage or credits. Check it BEFORE starting many or long agent ' +
  'runs, and stop or switch to a local model when a window nears 100%.';

const refreshShape = {
  refresh: z.boolean().optional().describe('Re-read now instead of the ≤ 60 s cached numbers.'),
};

export function registerPlanUsageTool(
  server: McpServer,
  resolve: (instance: string | undefined) => LatticeClient | ToolResult,
  instanceShape: Record<string, z.ZodTypeAny> = {},
): void {
  server.registerTool(
    'plan_usage',
    { description: DESCRIPTION, inputSchema: { ...instanceShape, ...refreshShape } },
    async (args: { instance?: string; refresh?: boolean }) => {
      const client = resolve(args.instance);
      if (!('call' in client)) return client;
      return toToolResult(await client.call('/api/plan-usage', { query: { refresh: args.refresh ? 1 : undefined } }));
    },
  );
}
