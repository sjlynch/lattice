// The write tools every session gets: `create_task`, `create_tasks`, and
// `append_summary` (how an agent reports). Registration order is what the
// model sees; keep it.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LatticeClient } from '../client.js';
import type { CreateLatticeMcpServerOptions } from '../createServer.js';
import { toToolResult } from '../toolResult.js';

export function registerWriteTools(
  server: McpServer,
  client: LatticeClient,
  opts: Pick<CreateLatticeMcpServerOptions, 'taskId'>,
): void {
  // ---- Write ----------------------------------------------------------------

  server.registerTool(
    'create_task',
    {
      description:
        'Create one task in the Open lane. Creating several? Use create_tasks — ' +
        'one round trip instead of N.',
      inputSchema: {
        title: z.string().describe('Short task title.'),
        description: z
          .string()
          .optional()
          .describe('Markdown brief the worktree agent will be given.'),
      },
    },
    async ({ title, description }) =>
      toToolResult(
        await client.call('/api/tasks', { method: 'POST', body: { title, description } }),
      ),
  );

  server.registerTool(
    'create_tasks',
    {
      description:
        'Create several tasks in one round trip. Returns the created tasks with ' +
        'their ids, in order. Prefer this over repeated create_task calls.',
      inputSchema: {
        tasks: z
          .array(
            z.object({
              title: z.string().describe('Short task title.'),
              description: z.string().optional().describe('Markdown brief.'),
            }),
          )
          .min(1)
          .describe('The tasks to create.'),
      },
    },
    async ({ tasks }) =>
      toToolResult(await client.call('/api/tasks/batch', { method: 'POST', body: { tasks } })),
  );

  // `append_summary` is how an agent REPORTS — it belongs to every session,
  // and a worktree agent's most of all, so it is registered ahead of the
  // board-management cut (`createServer.ts`).
  server.registerTool(
    'append_summary',
    {
      description:
        "Append a markdown summary beneath a task's description — how an agent " +
        'reports what it did. Never overwrites anything (unlike update_task).' +
        (opts.taskId
          ? ` Omit id to report on the task this session is running (${opts.taskId}).`
          : ''),
      inputSchema: {
        // Optional ONLY when there is a session task to default to. In every
        // other session the schema keeps `id` required, so the model is told up
        // front rather than discovering it from the error below.
        id: opts.taskId
          ? z
              .string()
              .optional()
              .describe(`Task id. Defaults to this session's own task (${opts.taskId}).`)
          : z.string().describe('Task id.'),
        summary: z.string().describe('Markdown or plain text to append.'),
      },
    },
    async ({ id, summary }) => {
      // The default only exists in a worktree session; elsewhere the schema
      // already requires `id`, and this is the belt to that suspender.
      const target = id ?? opts.taskId;
      if (!target) {
        return {
          content: [
            {
              type: 'text',
              text:
                'append_summary needs an id: this session is not running a task, so ' +
                'there is no default. Find the task with list_tasks or search_tasks first.',
            },
          ],
          isError: true,
        };
      }
      return toToolResult(
        await client.call(`/api/tasks/${encodeURIComponent(target)}/append-summary`, {
          method: 'POST',
          body: { summary },
        }),
      );
    },
  );
}
