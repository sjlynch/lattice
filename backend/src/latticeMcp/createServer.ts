// The Lattice task-board MCP server: 11 typed board tools over the HTTP API in
// `routes/tasks/` (plus the three Opengrep tools — scan / findings / ignore —
// over `routes/opengrep.ts`; ignore outside task worktrees only), pinned to ONE
// project. Typed tools beat the HTTP docs: `project` is pinned by the client,
// the canonical-project check is automatic, and the TOOL DESCRIPTIONS carry the
// progressive-disclosure ladder (`board_summary` → `list_tasks` → `get_task` →
// `search_tasks`) where the model reads it — unfiltered `GET /api/tasks` is a
// megabyte of done tasks.
//
// Design rules, all load-bearing:
//   - NO tool takes a `project` argument. See `client.ts`.
//   - NO tool invents a default the API already has: `list_tasks` forwards only
//     the args it was given, so the API stays the single source of truth.
//   - Results are one text block of compact JSON (a pretty print costs tokens).
//   - HTTP 413 comes back as a NORMAL result (see `client.ts`).
//   - Nothing here (or in `toolResult.ts` / `tools/`) imports the backend beyond
//     `client.ts`: the server is its own short-lived, harness-spawned process
//     (`server.ts`) and must not drag in the task cache, Express, or node-pty.
// The tools live in `tools/`, one module per tier; this file only fixes their
// ORDER (which the model sees) and the worktree-session cut. The opt-in
// multi-instance controller mode reuses the board tiers through `ToolHost`
// (`createControllerServer.ts`).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LatticeClient,
  type FetchLike,
  type LatticeClientOptions,
} from './client.js';
import { registerBoardManagementTools } from './tools/boardManagementTools.js';
import { registerPlanUsageTool } from './tools/usageTools.js';
import { registerFleetTools } from './tools/fleetTools.js';
import { registerOpengrepIgnoreTool, registerOpengrepTools } from './tools/opengrepTools.js';
import { registerReadTools } from './tools/readTools.js';
import { registerWriteTools } from './tools/writeTools.js';
import { pinnedScope, ToolHost } from './toolHost.js';

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
  // A user-started session (`LATTICE_FLEET=1`): register the Fleet tools.
  fleet?: boolean;
  // Injectable for tests; defaults to the global `fetch`.
  fetchImpl?: FetchLike;
  // Restart-retry tuning, passed through to LatticeClient (tests use 0).
  retry?: LatticeClientOptions['retry'];
};

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
            'create_task instead. Nor is opengrep_ignore: name Opengrep findings you ' +
            'judge to be rule noise in your summary instead.'
          : ''),
    },
  );

  const host = new ToolHost(server, pinnedScope(client));
  // board_summary, list_tasks, get_task, my_task (worktree sessions only),
  // search_tasks.
  registerReadTools(host, opts);
  // create_task, create_tasks, append_summary — in every session.
  registerWriteTools(host, opts);
  // opengrep_scan, opengrep_findings — read-only, in every session.
  registerOpengrepTools(server, client);

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
  //
  // `opengrep_ignore` sits behind the same cut, for the same reason: it
  // appends to the project's Opengrep ignore lists PERMANENTLY, so a bad brief
  // could have a task agent suppress the very findings its own change
  // introduced — hidden from every later security-review digest until a human
  // happened to spot the entries in Settings → Tools. It is the settings write
  // a planning agent makes; a worktree agent keeps the read-only scan/findings.
  if (opts.taskId) return server;

  // opengrep_ignore.
  registerOpengrepIgnoreTool(server, client);
  // update_task, transition_tasks, delete_task, run_task.
  registerBoardManagementTools(host);
  // plan_usage — machine-wide subscription usage, for sessions that launch runs.
  registerPlanUsageTool(server, () => client);
  // fleet, open_agent, read/send/wait_terminal — user-started sessions only.
  if (opts.fleet) registerFleetTools(server, () => client);

  return server;
}
