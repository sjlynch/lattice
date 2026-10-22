// The Fleet snapshot and activity log. Snapshot: a project shows when it has
// live terminals, agents, runs or tasks in flight, or was touched this week —
// a stale idle one is left out; terminals take their tab label / owner /
// harness from the registry record matching their pty and are marked busy
// from the activity set; live projects sort first. Log: bounded, `since`
// cursor, newest-limited. Finished work waiting on review lists Ready to merge
// before QA, with the second opinion's verdict.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createFleetEventLog } from '../fleet/events.js';
import { buildFleetProjects, type FleetSnapshotDeps } from '../fleet/snapshot.js';

const NOW = Date.parse('2026-10-22T20:00:00Z');
const DAY = 24 * 3600_000;
const A = 'C:\\proj\\alpha';
const B = 'C:\\proj\\beta';
const C = 'C:\\proj\\stale';

function deps(over: Partial<FleetSnapshotDeps> = {}): FleetSnapshotDeps {
  return {
    knownProjects: async () => [A, B, C],
    tasksOf: async (p) => (p === A
      ? [{ id: 't1', title: 'Fix it', status: 'in_progress', harness: 'codex', model: 'gpt-6-luna', startedAt: NOW - 60_000 }, { id: 't2', title: 'Old', status: 'done', doneAt: NOW - 2 * DAY },
        { id: 't8', title: 'In QA', status: 'qa', mergedAt: NOW - 500 },
        { id: 't7', title: 'Ready one', status: 'ready_to_merge', completedAt: NOW - 1000, review: { status: 'accepted', p: 92, reason: 'covers it' } }]
      : p === B
        ? [{ id: 't3', title: 'Recent', status: 'open', createdAt: NOW - DAY }]
        : [{ id: 't4', title: 'Ancient', status: 'open', createdAt: NOW - 30 * DAY }]),
    workflowRuns: (p) => (p === A ? [{ id: 'w1', workflowName: 'Bug hunt', status: 'running', startedAt: NOW - 1000, currentStepIndex: 1, totalSteps: 4 }] : []),
    mergeRun: () => null,
    agents: (p) => (p === A ? [{ agentId: 'claude:s1', label: 'Claude session', harness: 'claude', startedAt: NOW - 5000 }] : []),
    ptys: async () => [
      { id: 'pty1', projectPath: A, cwd: A, createdAt: NOW - 9000, lastTextOutputAt: NOW - 100, initialCommand: 'claude --dangerously-skip-permissions' },
      { id: 'pty2', projectPath: 'c:\\proj\\beta', cwd: B, createdAt: NOW - 8000, initialCommand: 'cmd.exe' },
      { id: 'pty9' },
    ],
    records: () => [{ id: 'tab1', serverId: 'pty1', label: 'Claude 2', owner: 'user', launch: { harness: 'claude' } }],
    busy: () => new Set(['pty1']),
    harnessFor: (c) => (c?.startsWith('claude') ? 'claude' : null),
    now: () => NOW,
    ...over,
  };
}

test('buildFleetProjects: live and recent projects only, live first, with lanes, runs, agents, terminals', async () => {
  const projects = await buildFleetProjects(deps());
  assert.deepEqual(projects.map((p) => p.name), ['alpha', 'beta']);
  const [a, b] = projects;
  assert.equal(a.lanes.in_progress, 1);
  assert.equal(a.lanes.done, 1);
  assert.deepEqual(a.inProgress, [{ id: 't1', title: 'Fix it', status: 'in_progress', harness: 'codex', model: 'gpt-6-luna' }]);
  assert.deepEqual(a.toReview, [
    { id: 't7', title: 'Ready one', status: 'ready_to_merge', review: { status: 'accepted', p: 92, reason: 'covers it' } },
    { id: 't8', title: 'In QA', status: 'qa' },
  ]);
  assert.deepEqual(a.runs, [{ id: 'w1', kind: 'workflow', label: 'Bug hunt · step 2/4', status: 'running', startedAt: NOW - 1000 }]);
  assert.equal(a.agents[0].agentId, 'claude:s1');
  assert.deepEqual(a.terminals, [{ id: 'pty1', tabId: 'tab1', label: 'Claude 2', owner: 'user', harness: 'claude', busy: true, createdAt: NOW - 9000, lastOutputAt: NOW - 100 }]);
  // A pty whose projectPath spells the project differently still groups with it.
  assert.equal(b.terminals.length, 1);
  assert.equal(b.terminals[0].busy, false);
});

test('buildFleetProjects survives an unreachable executor', async () => {
  const projects = await buildFleetProjects(deps({ ptys: async () => null }));
  assert.deepEqual(projects.map((p) => p.name), ['alpha', 'beta']);
  assert.deepEqual(projects[0].terminals, []);
});

test('the event log is bounded, cursor-paged and newest-limited', () => {
  let t = 0;
  const log = createFleetEventLog(5, () => ++t);
  for (let i = 1; i <= 8; i++) log.push(A, 'task', `e${i}`);
  assert.equal(log.seq(), 8);
  assert.deepEqual(log.since(0).map((e) => e.text), ['e4', 'e5', 'e6', 'e7', 'e8']);
  assert.deepEqual(log.since(6).map((e) => e.seq), [7, 8]);
  assert.deepEqual(log.since(0, 2).map((e) => e.text), ['e7', 'e8']);
  assert.deepEqual(log.since(8), []);
});
