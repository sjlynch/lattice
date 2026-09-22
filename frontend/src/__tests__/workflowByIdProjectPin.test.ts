import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cancelWorkflowRun, deleteWorkflow, updateWorkflow } from '../api/workflows';

// The backend's by-id workflow routes (PATCH / DELETE /api/workflows/:id and
// POST /api/workflow-runs/:runId/cancel) 404 a workflow or run from another
// project only when the caller sends `?project=`. The UI must pin all three to
// the active project; an empty project omits the param (unpinned).

const PROJECT = 'C:\\dev\\my proj&x';
const Q = `?project=${encodeURIComponent(PROJECT)}`;

async function captureRequests(fn: () => Promise<unknown>) {
  const g = globalThis as { fetch: typeof fetch };
  const original = g.fetch;
  const calls: { url: string; method: string }[] = [];
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    g.fetch = original;
  }
  return calls;
}

test('updateWorkflow / deleteWorkflow / cancelWorkflowRun send ?project=', async () => {
  const calls = await captureRequests(async () => {
    await updateWorkflow(PROJECT, 'wf 1', { name: 'n' });
    await deleteWorkflow(PROJECT, 'wf 1');
    await cancelWorkflowRun(PROJECT, 'run/1');
  });
  assert.deepEqual(calls, [
    { url: `/api/workflows/wf%201${Q}`, method: 'PATCH' },
    { url: `/api/workflows/wf%201${Q}`, method: 'DELETE' },
    { url: `/api/workflow-runs/run%2F1/cancel${Q}`, method: 'POST' },
  ]);
});

test('an empty project omits the param', async () => {
  const calls = await captureRequests(async () => {
    await deleteWorkflow('', 'wf');
    await cancelWorkflowRun('', 'run');
  });
  assert.deepEqual(
    calls.map((c) => c.url),
    ['/api/workflows/wf', '/api/workflow-runs/run/cancel'],
  );
});
