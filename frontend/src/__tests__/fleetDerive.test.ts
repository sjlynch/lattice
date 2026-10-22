// Fleet panel copy and feed handling: lane summaries list only non-zero lanes
// in flow order; relative times scale; the feed merges by seq without
// duplicates, keeps the newest past its cap and displays newest first; the
// filter matches project, terminal, task and run text.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetEvent, FleetProject } from '../api';
import { ago, busyCount, feedNewestFirst, laneSummary, mergeFeed, projectMatches, projectName, reviewBadge, hostSummary } from '../components/fleet/fleetDerive';

const ev = (seq: number): FleetEvent => ({ seq, at: seq, projectPath: 'C:\\p\\a', kind: 'task', text: `e${seq}` });
const project: FleetProject = {
  path: 'C:\\proj\\alpha', name: 'alpha', lastActivityAt: 0,
  lanes: { backlog: 0, open: 5, in_progress: 2, ready_to_merge: 1, qa: 0, done: 9 },
  inProgress: [{ id: 't1', title: 'Fix the parser', status: 'in_progress' }],
  toReview: [],
  runs: [{ id: 'w1', kind: 'workflow', label: 'Bug hunt · step 2/4', status: 'running' }],
  agents: [],
  terminals: [{ id: 'p1', label: 'Claude 2', busy: true, createdAt: 0 }, { id: 'p2', label: 'cmd', busy: false, createdAt: 0 }],
};

test('laneSummary', () => {
  assert.equal(laneSummary(project.lanes), '2 running · 1 to merge · 5 open');
  assert.equal(laneSummary({ done: 3 }), 'no open tasks');
});

test('ago', () => {
  assert.equal(ago(1000, 5000), 'now');
  assert.equal(ago(0, 42_000), '42 s');
  assert.equal(ago(0, 5 * 60_000), '5 min');
  assert.equal(ago(0, 3 * 3600_000), '3 h');
  assert.equal(ago(0, 3 * 86400_000), '3 d');
});

test('mergeFeed dedupes by seq, caps oldest-out; feedNewestFirst reverses', () => {
  const kept = mergeFeed([ev(1), ev(2)], [ev(2), ev(3), ev(4)], 3);
  assert.deepEqual(kept.map((e) => e.seq), [2, 3, 4]);
  assert.equal(mergeFeed(kept, []), kept);
  assert.deepEqual(feedNewestFirst(kept).map((e) => e.seq), [4, 3, 2]);
});

test('projectMatches, projectName, busyCount', () => {
  assert.ok(projectMatches(project, 'ALPHA'));
  assert.ok(projectMatches(project, 'parser'));
  assert.ok(projectMatches(project, 'claude 2'));
  assert.ok(projectMatches(project, 'bug hunt'));
  assert.ok(!projectMatches(project, 'zebra'));
  assert.ok(projectMatches(project, '  '));
  assert.equal(projectName('C:\\proj\\alpha\\'), 'alpha');
  assert.equal(projectName('/home/u/beta'), 'beta');
  assert.equal(busyCount(project), 1);
});

test('reviewBadge reads the second opinion', () => {
  const t = { id: 'x', title: 'x', status: 'ready_to_merge' };
  assert.equal(reviewBadge(t), null);
  assert.deepEqual(reviewBadge({ ...t, review: { status: 'accepted', p: 91.6 } }), { text: 'accepted 92', tone: 'ok' });
  assert.deepEqual(reviewBadge({ ...t, review: { status: 'rejected', p: 12 } }), { text: 'doubtful 12', tone: 'warn' });
  assert.deepEqual(reviewBadge({ ...t, review: { status: 'reviewing' } }), { text: 'reviewing…', tone: 'muted' });
});

test('hostSummary lists harnesses, Pi models and plan usage', () => {
  assert.equal(hostSummary(undefined), '');
  assert.equal(
    hostSummary({ name: 'pc', harnesses: { claude: true, codex: false, pi: true }, piModels: ['ornith', 'qwen'], plans: [{ provider: 'claude', usedPercent: 13.4 }, { provider: 'codex' }] }),
    'Claude · Pi (ornith, qwen) · Claude 13%',
  );
});
