import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Task } from '../api';
import { useBulkRunStrips } from '../components/taskboard/hooks/useBulkRunStrips.ts';

// Regression: the taskboard launcher stays mounted across project switches, and
// `useBulkRunStrips` had no folder input. Clicking "Run all" on project A then
// switching to B left A's record alive: A's ids aren't in B's task list, so
// `deriveCounts` counted them as spawned and B's Open lane flashed "Started N
// tasks"; a "Resume all" spun "Resuming N tasks…" on B until the 12 s safety
// timeout, since A's `task-spawned` events stop arriving. A switch now drops
// every strip and clears every lane timer.

type Timer = { id: number; at: number; fn: () => void };

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let now: number;
let timers: Timer[];
let nextId: number;

beforeEach(() => {
  now = 0;
  timers = [];
  nextId = 1;
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  g.setTimeout = (fn: () => void, ms = 0) => {
    const id = nextId++;
    timers.push({ id, at: now + ms, fn });
    return id;
  };
  g.clearTimeout = (id: number) => {
    timers = timers.filter((t) => t.id !== id);
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

// Fire every fake timer due within `ms`, in order (including ones they arm).
async function advance(ms: number) {
  const until = now + ms;
  for (;;) {
    const due = timers
      .filter((t) => t.at <= until)
      .sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers = timers.filter((t) => t !== due);
    now = due.at;
    await act(async () => {
      due.fn();
    });
  }
  now = until;
}

function task(id: string, status: Task['status']): Task {
  return { id, status } as Task;
}

let latest!: ReturnType<typeof useBulkRunStrips>;
function Harness({ folder, tasks }: { folder: string; tasks: Task[] }) {
  latest = useBulkRunStrips(folder, tasks);
  return null;
}

test('a project switch clears every bulk strip and no old timer fires into the new project', async () => {
  const aTasks = [task('a1', 'open'), task('a2', 'in_progress')];
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, { folder: 'C:/projA', tasks: aTasks }),
    );
  });

  await act(async () => {
    latest.beginBulk('open', ['a1'], 'run');
    latest.beginBulk('in_progress', ['a2'], 'resume');
  });
  assert.equal(latest.bulkStrips.open?.phase, 'active');
  assert.equal(latest.bulkStrips.in_progress?.phase, 'active');

  // Switch to B — whose list (like useTaskList's post-switch `[]`) lacks A's ids.
  const bTasks = [task('b1', 'open')];
  await act(async () => {
    renderer.update(
      React.createElement(Harness, { folder: 'C:/projB', tasks: bTasks }),
    );
  });
  assert.deepEqual(latest.bulkStrips, {}, 'no strip carries over to project B');
  assert.equal(timers.length, 0, 'every lane timer of project A is cleared');

  // A late `task-spawned` for A's resume is ignored.
  await act(async () => {
    latest.noteBulkSpawned('a2');
  });
  assert.deepEqual(latest.bulkStrips, {});

  // Past the safety + dismiss windows nothing reappears.
  await advance(20000);
  assert.deepEqual(latest.bulkStrips, {});

  // B's own bulk run still tracks normally.
  await act(async () => {
    latest.beginBulk('open', ['b1'], 'run');
  });
  assert.deepEqual(latest.bulkStrips.open, {
    kind: 'run',
    phase: 'active',
    total: 1,
    spawned: 0,
    queued: 0,
  });

  await act(async () => {
    renderer.unmount();
  });
  assert.equal(timers.length, 0, 'unmount clears the pending timers');
});
