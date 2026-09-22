// The Lattice task-board MCP server: 11 typed board tools over the HTTP API in
// `routes/tasks/` (plus the three Opengrep tools — scan / findings / ignore —
// over `routes/opengrep.ts`), pinned to ONE project.
//
// Why a server and not just the HTTP docs: an agent reading LATTICE_API.md has
// to remember to pass `project=`, to check the echoed `canonicalProject`, and —
// the expensive one — that `GET /api/tasks` unfiltered is a megabyte of done
// tasks. Typed tools remove all three: `project` is pinned by the client, the
// canonical-project check is automatic, and the TOOL DESCRIPTIONS carry the
// progressive-disclosure ladder (orient with `board_summary` → scan with
// `list_tasks` → expand with `get_task` → find with `search_tasks`) where the
// model actually reads it, at every call site, for free.
//
// Design rules, all load-bearing:
//   - NO tool takes a `project` argument. See `client.ts`.
//   - NO tool invents a default the API already has. `list_tasks` forwards only
//     the args it was given, so the API stays the single source of truth for
//     "compact fields, active lanes, newest 100" — if that default changes
//     server-side, the tool follows without a code change here.
//   - Results are one text block of compact JSON. Agents parse it; a pretty
//     print would cost tokens for nothing.
//   - HTTP 413 comes back as a NORMAL result (see `client.ts`).
//
// Nothing in this file imports the rest of the backend beyond `client.ts` — the
// server runs as its own short-lived process (`server.ts`), spawned by the
// harness, and must not drag in the task cache, Express, or node-pty.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LatticeClient, type FetchLike, type LatticeCallOutcome } from './client.js';

export type CreateLatticeMcpServerOptions = {
  // Backend origin, e.g. `http://127.0.0.1:5184`.
  apiUrl: string;
  // Canonical project path this server is pinned to.
  project: string;
  // The task this session is running, when it is a task worktree's agent
  // (`LATTICE_TASK_ID`, set by the resolver for run/resume spawns only). Adds
  // the `my_task` tool and lets `append_summary` omit its `id`. Undefined for
  // every other kind of session — sidebar, workflow step, push, QA, hooks.
  taskId?: string;
  // Injectable for tests; defaults to the global `fetch`.
  fetchImpl?: FetchLike;
};

// The shape `registerTool` handlers return. Declared locally so this module
// doesn't depend on the SDK's internal type exports.
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

// The MCP-facing rendering of a client outcome. Only two of the five kinds are
// NOT errors: a normal 2xx, and the 413 teaching response the agent must read
// (flagging that one `isError` would make the model retry the same oversized
// call instead of narrowing it).
function toToolResult(outcome: LatticeCallOutcome): ToolResult {
  const isError =
    outcome.kind === 'unreachable' ||
    outcome.kind === 'httpError' ||
    outcome.kind === 'projectMismatch';
  return {
    content: [{ type: 'text', text: outcome.text }],
    ...(isError ? { isError: true } : {}),
  };
}

// `DELETE /api/tasks/:id` answers `{ok, keptBranch: {name, unmergedCommits,
// hint}}` when the task's branch had unmerged work and was kept. Lead the
// result with that hint as plain text so the agent reads it rather than
// having to spot a field in the JSON (which still follows, unchanged).
function withKeptBranchHint(outcome: LatticeCallOutcome): LatticeCallOutcome {
  if (outcome.kind !== 'ok') return outcome;
  try {
    const parsed = JSON.parse(outcome.text) as { keptBranch?: { hint?: unknown } };
    const hint = parsed?.keptBranch?.hint;
    if (typeof hint === 'string' && hint) {
      return { kind: 'ok', text: `${hint}\n${outcome.text}` };
    }
  } catch {
    /* not JSON — leave it as is */
  }
  return outcome;
}

// Shared arg descriptions, so the same phrasing reaches the model from
// `list_tasks` and `search_tasks` alike.
const STATUS_DESC =
  'Comma-separated lanes (backlog,open,in_progress,ready_to_merge,qa,done,deleted) or "all".';

export function createLatticeMcpServer(
  opts: CreateLatticeMcpServerOptions,
): McpServer {
  const client = new LatticeClient(opts);
  const server = new McpServer(
    { name: 'lattice', version: '1.0.0' },
    {
      instructions:
        `Lattice task board for ${opts.project}. Every tool acts on THAT project ` +
        'only — none of them take a project argument. Orient with board_summary ' +
        'before listing: an unfiltered board can be hundreds of thousands of ' +
        'tokens. Then list_tasks to scan, get_task to expand one, search_tasks to ' +
        'find without listing.' +
        (opts.taskId
          ? ` This session is running task ${opts.taskId}: my_task returns it, and ` +
            'append_summary with no id reports on it. Board management (update, ' +
            'transition, delete, run) is not offered here — file follow-ups with ' +
            'create_task instead.'
          : ''),
    },
  );

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
  // board-management cut below.
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

  // ---- Opengrep (SAST) -------------------------------------------------------
  //
  // Both tools return the agent-facing DIGEST (markdown, severity-ordered,
  // grouped rule → file, under the project's byte budget), never the raw JSON.
  // Available in every session: a worktree agent fixing a finding wants the
  // drill-down for its file as much as a planner wants the overview.

  // Unwrap the `markdown` field of a scan envelope into the text block; every
  // other outcome (busy / not installed / unreachable) passes through as-is.
  const digestResult = (outcome: LatticeCallOutcome): ToolResult => {
    if (outcome.kind !== 'ok') return toToolResult(outcome);
    try {
      const parsed = JSON.parse(outcome.text) as { markdown?: unknown; digest?: unknown; scan?: unknown };
      if (typeof parsed.markdown === 'string') {
        return { content: [{ type: 'text', text: parsed.markdown }] };
      }
    } catch {
      /* fall through */
    }
    return toToolResult(outcome);
  };

  server.registerTool(
    'opengrep_scan',
    {
      description:
        'Run an Opengrep static-analysis (SAST) scan of this project with its ' +
        "configured rule packs and return the findings DIGEST: markdown, worst " +
        'severity first, grouped by rule then file, each finding tagged with a ' +
        'short fingerprint (`fp`). Put `opengrep:<fp>` on its own line in any task ' +
        'you file for a finding and search_tasks for it first so re-runs do not ' +
        'duplicate. A scan takes seconds to minutes; one runs per project at a ' +
        'time (a second call reports busy). If the digest says findings were cut ' +
        'for the byte budget, use opengrep_findings with rule= to drill down.',
      inputSchema: {
        targets: z
          .array(z.string())
          .optional()
          .describe('Project-relative paths to scan instead of the whole project.'),
      },
    },
    async ({ targets }) =>
      digestResult(
        await client.call('/api/opengrep/scan', {
          method: 'POST',
          body: { ...(targets?.length ? { targets } : {}), includeMarkdown: true },
        }),
      ),
  );

  server.registerTool(
    'opengrep_findings',
    {
      description:
        'The digest of an EXISTING Opengrep scan (the latest by default) without ' +
        'scanning again — narrowed by rule id, file path or severity floor, and ' +
        'with an optional larger byte budget. This is the drill-down when a digest ' +
        'says rules were left out, and the cheap way to re-read findings for one ' +
        'file. Returns an error if the project has never been scanned.',
      inputSchema: {
        scan: z.string().optional().describe('Scan id from an earlier scan; default "latest".'),
        rule: z
          .string()
          .optional()
          .describe('Only this rule: the full check id or any dot-suffix of it (e.g. "xss.foo").'),
        file: z.string().optional().describe('Only this project-relative file or directory.'),
        severity: z
          .enum(['ERROR', 'WARNING', 'INFO'])
          .optional()
          .describe('Severity floor for this read (INFO shows everything). Default: the project setting.'),
        budgetKb: z
          .number()
          .int()
          .min(8)
          .optional()
          .describe('Digest size ceiling in KB for this read (default: the project setting, 60).'),
      },
    },
    async ({ scan, rule, file, severity, budgetKb }) =>
      digestResult(
        await client.call(`/api/opengrep/scans/${encodeURIComponent(scan ?? 'latest')}`, {
          query: { include: 'markdown', rule, file, severity, budgetKb },
        }),
      ),
  );

  server.registerTool(
    'opengrep_ignore',
    {
      description:
        "Add rule ids and/or finding fingerprints to THIS project's Opengrep ignore " +
        'list, so they are filtered out of every future digest. Use it for findings ' +
        'you have judged to be rule noise for this codebase (a rule that ' +
        'misfires on a local helper, a policy the project already meets another ' +
        'way) instead of filing a task that asks a human to do it. Additive and ' +
        'deduplicated; entries are removed in Settings → Tools. Say in your ' +
        'wrap-up what you ignored and why.',
      inputSchema: {
        ruleIds: z
          .array(z.string())
          .optional()
          .describe('Rule ids to ignore: full check ids or any dot-suffix (e.g. "i18next-key-format").'),
        fingerprints: z
          .array(z.string())
          .optional()
          .describe('Individual findings to ignore, by the short fp from the digest (the `opengrep:<fp>` spelling is accepted).'),
        reason: z.string().optional().describe('One line on why — echoed back, not stored.'),
      },
    },
    async ({ ruleIds, fingerprints, reason }) => {
      const outcome = await client.call('/api/opengrep/ignore', {
        method: 'POST',
        body: {
          ...(ruleIds?.length ? { ruleIds } : {}),
          ...(fingerprints?.length ? { fingerprints } : {}),
        },
      });
      const result = toToolResult(outcome);
      // Echo the agent's stated reason back with the result (it is never sent
      // to the API), so the transcript carries the why next to the what.
      const why = reason?.trim();
      if (why && !result.isError) {
        result.content = [{ type: 'text', text: `${outcome.text}\nreason: ${why}` }];
      }
      return result;
    },
  );

  // ---- Board management: NOT registered in a task-worktree session ----------
  //
  // A worktree agent's job is one task; its brief is untrusted input written by
  // a planner or a user. It needs to read the board, file follow-ups, and report
  // on itself — not re-lane, delete, or spawn agents on other tasks. Offering
  // those as one-call typed tools in every worktree session widens the blast
  // radius of a bad brief for no gain (the HTTP API remains available to an
  // agent that truly needs it, with the friction that implies). Planners,
  // sidebar sessions and the user's own `claude` get the full set. Leaving them
  // out also trims the per-spawn tool-definition cost for the most numerous
  // session type.
  if (opts.taskId) return server;

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

  return server;
}
