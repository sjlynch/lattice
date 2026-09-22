import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteTask, parseDeleteTaskResult } from '../api/tasks';

// DELETE /api/tasks/:id may carry `keptBranch` when the task's branch had
// unmerged commits and was kept; the board toasts its `hint`. The field is
// optional (older backends) and a malformed one must never reach the toast.

const KEPT = { name: 'lattice/foo-abc123', unmergedCommits: 2, hint: 'Branch kept: git log main..lattice/foo-abc123' };

test('parses a well-formed keptBranch', () => {
  assert.deepEqual(parseDeleteTaskResult({ ok: true, keptBranch: KEPT }), { ok: true, keptBranch: KEPT });
});

test('tolerates an absent or malformed keptBranch', () => {
  assert.deepEqual(parseDeleteTaskResult({ ok: true }), { ok: true });
  assert.deepEqual(parseDeleteTaskResult(null), {});
  assert.deepEqual(parseDeleteTaskResult({ ok: true, keptBranch: null }), { ok: true });
  assert.deepEqual(parseDeleteTaskResult({ ok: true, keptBranch: { name: 'x' } }), { ok: true });
  assert.deepEqual(parseDeleteTaskResult({ keptBranch: { name: 'x', hint: '  ' } }), {});
  assert.deepEqual(
    parseDeleteTaskResult({ keptBranch: { name: 'x', hint: 'h' } }),
    { keptBranch: { name: 'x', unmergedCommits: 0, hint: 'h' } },
  );
});

test('deleteTask resolves the parsed body', async () => {
  const g = globalThis as { fetch: typeof fetch };
  const original = g.fetch;
  g.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ ok: true, keptBranch: KEPT }) }) as unknown as Response) as typeof fetch;
  try {
    const res = await deleteTask('C:\\p', 't1');
    assert.deepEqual(res.keptBranch, KEPT);
  } finally {
    g.fetch = original;
  }
});
