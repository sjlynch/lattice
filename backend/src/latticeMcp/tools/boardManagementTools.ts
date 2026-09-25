// The board-management tools: `update_task`, `transition_tasks`,
// `delete_task`, `run_task`. `createServer.ts` registers these ONLY when the
// session is not a task worktree's agent (see the gate there for why).
// Registration order is what the model sees; keep it.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LatticeClient } from '../client.js';
import { toToolResult, withKeptBranchHint } from '../toolResult.js';

export function registerBoardManagementTools(server: McpServer, client: LatticeClient): void {
  server.registerTool(
    'update_task',
    {
      description:
        "Update one task's title, description, or lane. description REPLACES " +
        'the existing text — to add findings without losing the brief, use ' +
        'append_summary. Moving many tasks at once? Use transition_tasks.',
      inputSchema: {
        id: z.string().describe('Task id.'),
        title: z.string().optional(),
        description: z.string().optional().describe('Replaces the existing description.'),
        status: z
          .enum(['backlog', 'open', 'in_progress', 'ready_to_merge', 'qa', 'done', 'deleted'])
          .optional()
          .describe('Target lane.'),
      },
    },
    async ({ id, title, description, status }) =>
      toToolResult(
        await client.call(`/api/tasks/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: {
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(status !== undefined ? { status } : {}),
          },
        }),
      ),
  );

  server.registerTool(
    'transition_tasks',
    {
      description:
        'Move many tasks to one lane in a single call — either the explicit ids ' +
        'you pass, or every task currently in fromStatus. Use this instead of a ' +
        'loop of update_task calls.',
      inputSchema: {
        status: z
          .enum(['backlog', 'open', 'in_progress', 'ready_to_merge', 'qa', 'done', 'deleted'])
          .describe('Target lane.'),
        ids: z.array(z.string()).optional().describe('Explicit task ids to move.'),
        fromStatus: z
          .enum(['backlog', 'open', 'in_progress', 'ready_to_merge', 'qa', 'done', 'deleted'])
          .optional()
          .describe('Move every task in this lane instead (ignored when ids is given).'),
      },
    },
    async ({ status, ids, fromStatus }) =>
      toToolResult(
        await client.call('/api/tasks/transition', {
          method: 'POST',
          body: {
            status,
            ...(ids !== undefined ? { ids } : {}),
            ...(fromStatus !== undefined ? { fromStatus } : {}),
          },
        }),
      ),
  );

  server.registerTool(
    'delete_task',
    {
      description:
        'PERMANENTLY remove a task: the record is erased (not moved to the ' +
        'deleted lane) and any worktree it has is torn down. Its branch is ' +
        'deleted too UNLESS it has commits not on HEAD — then it is kept and ' +
        'the result starts with a hint naming it. Cannot be undone. To bin it ' +
        'recoverably, move it to "deleted" with update_task or ' +
        'transition_tasks; to retire finished work, move it to done.',
      inputSchema: { id: z.string().describe('Task id.') },
    },
    async ({ id }) =>
      toToolResult(
        withKeptBranchHint(
          await client.call(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
        ),
      ),
  );

  server.registerTool(
    'run_task',
    {
      description:
        'Start an agent on an Open task in its own git worktree. Returns ' +
        '{accepted, queued}: the run is ADMITTED, not started — the worktree and ' +
        'terminal arrive later, so do NOT call this again because nothing seems ' +
        'to have happened. Poll get_task to watch it reach in_progress.',
      inputSchema: {
        id: z.string().describe('Task id (must be in the Open lane).'),
        harness: z
          .enum(['claude', 'codex', 'pi'])
          .optional()
          .describe("Agent CLI to run; defaults to the project's setting."),
        piModel: z
          .string()
          .optional()
          .describe('With harness "pi": a "provider/model" id from the Pi model menu.'),
      },
    },
    async ({ id, harness, piModel }) =>
      toToolResult(
        await client.call(`/api/tasks/${encodeURIComponent(id)}/run`, {
          method: 'POST',
          body: {
            ...(harness !== undefined ? { harness } : {}),
            ...(piModel !== undefined ? { piModel } : {}),
          },
        }),
      ),
  );
}
