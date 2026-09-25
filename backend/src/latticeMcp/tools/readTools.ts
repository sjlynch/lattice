// The read tools — the progressive-disclosure tiers: orient (`board_summary`)
// → scan (`list_tasks`) → expand (`get_task`, plus `my_task` in a task
// worktree session) → find (`search_tasks`). Registration order is what the
// model sees; keep it.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LatticeClient } from '../client.js';
import type { CreateLatticeMcpServerOptions } from '../createServer.js';
import { STATUS_DESC, toToolResult } from '../toolResult.js';

export function registerReadTools(
  server: McpServer,
  client: LatticeClient,
  opts: Pick<CreateLatticeMcpServerOptions, 'taskId'>,
): void {
  // ---- Tier 0: orient -------------------------------------------------------

  server.registerTool(
    'board_summary',
    {
      description:
        'START HERE. Task counts per lane for this project, plus what each lane ' +
        'would COST to read in full (bytes + approximate tokens). Under 1 KB. ' +
        'Read this before list_tasks so a listing never surprises you.',
      inputSchema: {},
    },
    async () => toToolResult(await client.call('/api/tasks/summary')),
  );

  // ---- Tier 1: scan ---------------------------------------------------------

  server.registerTool(
    'list_tasks',
    {
      description:
        'Scan the board. By DEFAULT the API returns compact fields, the active ' +
        'lanes only (backlog, open, in_progress, ready_to_merge, qa — done and ' +
        'deleted are omitted) and the 100 most recently active, newest first. ' +
        'Pass status to reach history, ids to fetch specific tasks, ' +
        'fields:"full" for description/summary text. Use get_task for one ' +
        "task's full text, search_tasks to FIND tasks instead of listing them, " +
        "and board_summary first if you don't know how big the board is.",
      inputSchema: {
        status: z.string().optional().describe(STATUS_DESC + ' Default: the active lanes.'),
        ids: z
          .array(z.string())
          .optional()
          .describe('Specific task ids. Bypasses lane filtering and returns full records.'),
        since: z
          .string()
          .optional()
          .describe('Only tasks active since then: an ISO timestamp, epoch ms, or "30d"/"12h"/"90m".'),
        limit: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Max tasks (default 100, max 1000, 0 = unlimited).'),
        fields: z
          .enum(['compact', 'full'])
          .optional()
          .describe('"compact" (default) omits description/summary text; "full" includes it, clipped.'),
        clip: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('With fields:"full", max chars per description/summary (default 500, 0 = unlimited).'),
        // The escape hatch past the 256 KB ceiling. Without it the 413 teaching
        // response would be a dead end for an MCP-only agent that genuinely
        // needs the whole board (a bulk re-triage, say) — every other knob only
        // narrows. Described as a last resort so the model reaches for the
        // narrowing knobs first.
        confirm_large: z
          .boolean()
          .optional()
          .describe(
            'Accept a response over the 256 KB ceiling instead of a 413. Last resort — ' +
              'check board_summary for the cost first, and prefer status/since/limit/fields.',
          ),
      },
    },
    async (args) =>
      toToolResult(
        await client.call('/api/tasks', {
          // Only what the caller actually passed — the API owns the defaults.
          query: {
            status: args.status,
            ids: args.ids?.length ? args.ids.join(',') : undefined,
            since: args.since,
            limit: args.limit,
            fields: args.fields,
            clip: args.clip,
            confirm_large: args.confirm_large ? 1 : undefined,
          },
        }),
      ),
  );

  // ---- Tier 2: expand -------------------------------------------------------

  server.registerTool(
    'get_task',
    {
      description:
        'The full, unclipped record for one task. Use it after list_tasks or ' +
        'search_tasks; for several tasks at once pass their ids to list_tasks ' +
        'instead of calling this in a loop.',
      inputSchema: { id: z.string().describe('Task id.') },
    },
    async ({ id }) => toToolResult(await client.call(`/api/tasks/${encodeURIComponent(id)}`)),
  );

  // Registered ONLY when the session is a task worktree's agent. A worktree
  // agent's most common board question is "what am I doing, exactly?" — its
  // brief is in LATTICE_TASK.md, but the live record (status, appended
  // summaries from a previous attempt, conflict flag) is here, and it should
  // not have to read its own id back out of a file to ask.
  if (opts.taskId) {
    const taskId = opts.taskId;
    server.registerTool(
      'my_task',
      {
        description:
          `The full, live record of the task THIS session is running (${taskId}) — ` +
          'status, description, any summaries appended so far. No arguments.',
        inputSchema: {},
      },
      async () => toToolResult(await client.call(`/api/tasks/${encodeURIComponent(taskId)}`)),
    );
  }

  // ---- Find -----------------------------------------------------------------

  server.registerTool(
    'search_tasks',
    {
      description:
        'Find tasks by text WITHOUT listing the board — the cheap way to reach ' +
        'history. Matches every whitespace-separated term against title + ' +
        'description + summary across ALL lanes (done included) and returns ' +
        'ranked {id, title, status, score, snippet}. Follow up with get_task ' +
        'for full text.',
      inputSchema: {
        q: z.string().describe('Search terms; a task must contain all of them (case-insensitive).'),
        status: z.string().optional().describe(STATUS_DESC + ' Default: all lanes.'),
        limit: z.number().int().min(1).optional().describe('Max results (default 20, max 200).'),
      },
    },
    async ({ q, status, limit }) =>
      toToolResult(await client.call('/api/tasks/search', { query: { q, status, limit } })),
  );
}
