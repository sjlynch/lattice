// Controller mode's workflow tools, over `routes/workflows/` (definitions:
// `crud.ts`; runs: `runs.ts`). Every request carries the requested `project`
// (`?project=` is the routes' ownership pin, so a foreign id is a 404 before
// anything is written or started), and every record that names a project is
// checked against it. Definitions and runs come back COMPACT
// (`workflowViews.ts`); only `get_workflow` returns step prompts.
//
// One active run per project: a second start is HTTP 409 `active-run-exists`,
// rendered as an error that says what to do instead.

import { z } from 'zod';
import { assertCanonicalProject, type LatticeCallOutcome, type LatticeClient } from '../client.js';
import type { ToolHost } from '../toolHost.js';
import { toToolResult, type ToolResult } from '../toolResult.js';
import { compactWorkflow, compactWorkflowRun } from '../workflowViews.js';

// `wait_workflow_run` polling: a run lasts minutes to hours, so a 10 s poll is
// cheap and responsive enough. `pollIntervalMs` overrides it (tests).
const RUN_POLL_INTERVAL_MS = 10_000;
const WAIT_DEFAULT_SECONDS = 600;
const WAIT_MAX_SECONDS = 3600;

const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

// The parsed body of a 2xx outcome, or the error result for anything else
// (including a record that names another project).
function parsed(client: LatticeClient, outcome: LatticeCallOutcome): { value: unknown } | { error: ToolResult } {
  if (outcome.kind !== 'ok') return { error: toToolResult(outcome) };
  let value: unknown;
  try {
    value = JSON.parse(outcome.text);
  } catch {
    return { error: fail(`Unexpected non-JSON response: ${outcome.text.slice(0, 500)}`) };
  }
  const records = Array.isArray(value) ? value : [(value as { run?: unknown } | null)?.run ?? value];
  for (const record of records) {
    const mismatch = assertCanonicalProject(client.project, record, 'argument');
    if (mismatch) return { error: fail(mismatch) };
  }
  return { value };
}

function runOf(value: unknown): unknown {
  return (value as { run?: unknown } | null)?.run ?? value;
}

const enc = encodeURIComponent;

export function registerWorkflowTools(host: ToolHost, opts: { pollIntervalMs?: number } = {}): void {
  const pollMs = Math.max(1, opts.pollIntervalMs ?? RUN_POLL_INTERVAL_MS);

  async function listDefinitions(client: LatticeClient) {
    return parsed(client, await client.call('/api/workflows'));
  }

  async function getRun(client: LatticeClient, runId: string) {
    return parsed(client, await client.call(`/api/workflow-runs/${enc(runId)}`));
  }

  host.tool(
    'list_workflows',
    {
      description:
        "The project's workflow definitions, compact: id, name, and per step its " +
        'title/kind/harness/model fields and prompt size (no prompts — use get_workflow).',
      inputSchema: {},
    },
    async (client) => {
      const r = await listDefinitions(client);
      if ('error' in r) return r.error;
      return ok((r.value as unknown[]).map(compactWorkflow));
    },
  );

  host.tool(
    'get_workflow',
    {
      description: 'One workflow definition in full, including every step prompt and variable.',
      inputSchema: { id: z.string().describe('Workflow id.') },
    },
    async (client, { id }) => {
      const r = await listDefinitions(client);
      if ('error' in r) return r.error;
      const found = (r.value as { id?: unknown }[]).find((w) => w?.id === id);
      if (!found) return fail(`No workflow ${id} in ${client.project}; list_workflows shows the ids.`);
      return ok(found);
    },
  );

  host.tool(
    'save_workflow',
    {
      description:
        'Create a workflow (no id) or update one (id). steps is the FULL ordered list and ' +
        'replaces the old one: keep a step id to update that step. Step fields: title, ' +
        'prompt, kind (agent|start|merge|push|test), harness (claude|codex|pi), piModel, ' +
        'frozen, parallel, tools (["opengrep"]), timeoutMinutes; others pass through verbatim. ' +
        'A run already started keeps the definition it started with.',
      inputSchema: {
        id: z.string().optional().describe('Workflow id to update; omit to create.'),
        name: z.string().optional(),
        steps: z.array(z.record(z.string(), z.unknown())).optional(),
        variables: z
          .array(z.record(z.string(), z.unknown()))
          .optional()
          .describe('[{name, value}] substituted into prompts as {{name}}; full list.'),
      },
    },
    async (client, { id, name, steps, variables }) => {
      const body = {
        ...(name !== undefined ? { name } : {}),
        ...(steps !== undefined ? { steps } : {}),
        ...(variables !== undefined ? { variables } : {}),
      };
      const outcome = id
        ? await client.call(`/api/workflows/${enc(id)}`, { method: 'PATCH', body })
        : await client.call('/api/workflows', { method: 'POST', body });
      const r = parsed(client, outcome);
      if ('error' in r) return r.error;
      return ok(compactWorkflow(r.value));
    },
  );

  host.tool(
    'delete_workflow',
    {
      description: 'Delete a workflow definition. Runs already started are unaffected.',
      inputSchema: { id: z.string().describe('Workflow id.') },
    },
    async (client, { id }) => toToolResult(await client.call(`/api/workflows/${enc(id)}`, { method: 'DELETE' })),
  );

  host.tool(
    'start_workflow_run',
    {
      description:
        'Start a run of a workflow. ONE active run per project: a second start fails ' +
        '(409 active-run-exists). Returns the compact run; follow it with wait_workflow_run.',
      inputSchema: {
        id: z.string().describe('Workflow id.'),
        overrides: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Run-wide overrides sent verbatim, e.g. {harnessOverride:"pi", piModelOverride:"p/m", ' +
              'agentModelOverride, effortOverride}.',
          ),
      },
    },
    async (client, { id, overrides }) => {
      const outcome = await client.call(`/api/workflows/${enc(id)}/run`, {
        method: 'POST',
        body: overrides ?? {},
      });
      if (outcome.kind === 'httpError' && outcome.status === 409 && outcome.text.includes('active-run-exists')) {
        return fail(
          `A workflow run is already active for ${client.project} (409 active-run-exists; one ` +
            'run per project). Wait for it (list_workflow_runs, wait_workflow_run) or ' +
            `cancel_workflow_run, then start again.\n${outcome.text}`,
        );
      }
      const r = parsed(client, outcome);
      if ('error' in r) return r.error;
      return ok(compactWorkflowRun(runOf(r.value)));
    },
  );

  host.tool(
    'get_workflow_run',
    {
      description:
        'One run, compact: status, current step(s), per-step phase/error/summary excerpt. ' +
        'Finished runs are kept in memory only (a backend restart forgets them: 404).',
      inputSchema: { runId: z.string().describe('Run id.') },
    },
    async (client, { runId }) => {
      const r = await getRun(client, runId);
      if ('error' in r) return r.error;
      return ok(compactWorkflowRun(runOf(r.value)));
    },
  );

  host.tool(
    'list_workflow_runs',
    {
      description: "The project's ACTIVE workflow runs (at most one), compact.",
      inputSchema: {},
    },
    async (client) => {
      const r = parsed(client, await client.call('/api/workflow-runs/active'));
      if ('error' in r) return r.error;
      return ok((r.value as unknown[]).map(compactWorkflowRun));
    },
  );

  host.tool(
    'wait_workflow_run',
    {
      description:
        'Block until a run is no longer running or timeoutSeconds pass, then return it ' +
        'compact with done:true/false. done:false is not an error — call again to keep ' +
        'waiting; never start a second run meanwhile.',
      inputSchema: {
        runId: z.string().describe('Run id.'),
        timeoutSeconds: z
          .number()
          .int()
          .min(0)
          .max(WAIT_MAX_SECONDS)
          .optional()
          .describe(`Default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}.`),
      },
    },
    async (client, { runId, timeoutSeconds }) => {
      const budgetMs = (timeoutSeconds ?? WAIT_DEFAULT_SECONDS) * 1000;
      let waited = 0;
      for (;;) {
        const r = await getRun(client, runId);
        if ('error' in r) return r.error;
        const run = runOf(r.value) as { status?: unknown };
        if (run?.status !== 'running') return ok({ done: true, run: compactWorkflowRun(run) });
        if (waited >= budgetMs) {
          return ok({
            done: false,
            note: `Still running after ${Math.round(waited / 1000)} s; call wait_workflow_run again.`,
            run: compactWorkflowRun(run),
          });
        }
        const step = Math.min(pollMs, budgetMs - waited);
        await client.pause(step);
        waited += step;
      }
    },
  );

  host.tool(
    'cancel_workflow_run',
    {
      description: 'Cancel an active workflow run and tear down its current step.',
      inputSchema: { runId: z.string().describe('Run id.') },
    },
    async (client, { runId }) =>
      toToolResult(await client.call(`/api/workflow-runs/${enc(runId)}/cancel`, { method: 'POST' })),
  );
}
