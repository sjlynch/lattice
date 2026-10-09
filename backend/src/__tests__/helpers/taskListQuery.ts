// Shared fixtures for the split taskListQuery.* suites — the pure half of
// GET /api/tasks (`routes/tasks/listQuery.ts`). The endpoint used to return
// every task, full text, uncapped — on a mature board that is ~500 tasks /
// >1 MB / ~320k tokens, which every agent hit because the docs showed the call
// that way. The suites pin the progressive-disclosure behaviour that replaced
// it, all on plain data — no Express, no task store. Not a `*.test.ts` file, so
// it isn't collected as a suite.
import assert from 'node:assert/strict';
import {
  buildListOutcome,
  parseListQuery,
  type ListEnvelope,
  type ListEnvelopeMeta,
  type ListQuery,
} from '../../routes/tasks/listQuery.js';
import type { Task } from '../../tasks.js';

const PROJECT = 'C:\\development\\lattice';
export const META: ListEnvelopeMeta = {
  project: PROJECT,
  canonicalProject: PROJECT,
  hash: 'abc123def456',
  mismatched: 0,
};

export function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectPath: PROJECT,
    title: `task ${id}`,
    status: 'open',
    createdAt: 1_000,
    ...over,
  };
}

export function parse(raw: Record<string, string | undefined>, now = 1_700_000_000_000): ListQuery {
  const parsed = parseListQuery(raw, now);
  assert.ok(parsed.ok, `expected parse to succeed: ${parsed.ok ? '' : parsed.error}`);
  return parsed.value;
}

export function listJson(tasks: Task[], raw: Record<string, string | undefined> = {}): ListEnvelope {
  const outcome = buildListOutcome(META, tasks, parse(raw));
  assert.equal(outcome.kind, 'json', `expected a json outcome, got ${outcome.kind}`);
  return (outcome as { kind: 'json'; body: ListEnvelope }).body;
}
