import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTasks } from '../api/tasks';

// `GET /api/tasks` defaults are tuned for AI agents: active lanes only, compact
// fields, newest 100, descriptions clipped, and a 256 KB ceiling that 413s. The
// board UI is the one caller that needs the WHOLE board as full records, so
// `fetchTasks` must opt out of every one of those — drop a single param in a
// refactor and the board silently loses its done lane, renders truncated
// descriptions, or 413s outright on every mature project.

test('fetchTasks opts out of every agent-facing list default', async () => {
  const g = globalThis as { fetch: typeof fetch };
  const original = g.fetch;
  let requested = '';
  g.fetch = (async (input: RequestInfo | URL) => {
    requested = String(input);
    return {
      ok: true,
      status: 200,
      json: async () => ({ tasks: [] }),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fetchTasks('C:/dev/proj');
  } finally {
    g.fetch = original;
  }

  const params = new URL(requested, 'http://placeholder').searchParams;
  assert.equal(params.get('project'), 'C:/dev/proj');
  assert.equal(params.get('status'), 'all', 'every lane, including done');
  assert.equal(params.get('fields'), 'full', 'whole records, not the compact projection');
  assert.equal(params.get('clip'), '0', 'descriptions unclipped');
  assert.equal(params.get('limit'), '0', 'no page cap');
  assert.equal(params.get('confirm_large'), '1', 'pre-confirms the size ceiling');
});
