// Shared result shaping for the Lattice MCP tool modules (`tools/`): the
// outcome → MCP-result mapping, the `delete_task` kept-branch hint, and arg
// descriptions more than one tool uses. Imports nothing beyond `client.ts`
// (see the header comment in `createServer.ts`).

import type { LatticeCallOutcome } from './client.js';

// The shape `registerTool` handlers return. Declared locally so this module
// doesn't depend on the SDK's internal type exports.
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

// The MCP-facing rendering of a client outcome. Only two of the six kinds are
// NOT errors: a normal 2xx, and the 413 teaching response the agent must read
// (flagging that one `isError` would make the model retry the same oversized
// call instead of narrowing it). A response `timeout` is an error for a generic
// tool (there is no result), but its text says the backend is up; a tool whose
// request is a long job (`opengrep_scan`) renders it itself.
export function toToolResult(outcome: LatticeCallOutcome): ToolResult {
  const isError =
    outcome.kind === 'unreachable' ||
    outcome.kind === 'timeout' ||
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
export function withKeptBranchHint(outcome: LatticeCallOutcome): LatticeCallOutcome {
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
export const STATUS_DESC =
  'Comma-separated lanes (backlog,open,in_progress,ready_to_merge,qa,done,deleted) or "all".';
