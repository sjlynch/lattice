import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  installManualTimers,
  type ManualTimers,
} from './domDoubles.ts';
import {
  TASK_TERMINAL_REATTACH_RETRY_DELAYS_MS,
  useTaskTerminalReattach,
} from '../components/taskboard/hooks/useTaskTerminalReattach.ts';
import type { Task } from '../api';
import type { TerminalSpec } from '../TerminalsContext';

const g = globalThis as unknown as Record<string, unknown>;
let saved: Record<string, unknown>;
let timers: ManualTimers;

const task: Task = {
  id: 'task-1',
  projectPath: 'C:/project-A',
  title: 'reattach me',
  status: 'in_progress',
  createdAt: 1,
  updatedAt: 1,
  worktreePath: 'C:/wt/task-1',
};

beforeEach(() => {
  saved = {
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
    React: g.React,
    fetch: g.fetch,
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.React = React;
  timers = installManualTimers();
});

afterEach(() => {
  timers.restore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

function Harness({
  addTerminal,
  tasks = [task],
}: {
  addTerminal: (spec: Omit<TerminalSpec, 'id'>) => string;
  tasks?: Task[];
}) {
  useTaskTerminalReattach('C:/project-A', tasks, [], addTerminal);
  return null;
}

// REGRESSION: the effect used to depend on the `tasks` array itself, so every
// `/ws/tasks` snapshot (a fresh array, same in-progress set) cancelled the
// in-flight retry chain and restarted it at attempt 0 — on a busy board the
// one-shot never completed and /api/terminals was polled indefinitely. It is
// now keyed on the set of reattachable task ids.
test('a tasks update during the retry backoff does not restart the chain', async () => {
  let calls = 0;
  const added: Array<Omit<TerminalSpec, 'id'>> = [];
  g.fetch = (url: string) => {
    assert.equal(url, '/api/terminals');
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([{ id: 'server-1', cwd: 'C:/wt/task-1' }]),
    });
  };
  const addTerminal = (spec: Omit<TerminalSpec, 'id'>) => {
    added.push(spec);
    return 'term-1';
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(Harness, { addTerminal }));
  });
  await act(async () => { await flush(); });
  assert.equal(calls, 1);
  assert.equal(timers.scheduled.length, 1, 'first failure schedules retry #1');
  const pendingRetry = timers.scheduled[0];

  // A live snapshot lands: a NEW array, same in-progress task (only a
  // timestamp moved). Before the fix this re-ran the effect, which cleared the
  // pending retry and issued a fresh attempt-0 fetch.
  await act(async () => {
    renderer.update(
      React.createElement(Harness, { addTerminal, tasks: [{ ...task, updatedAt: 2 }] }),
    );
    await flush();
  });
  assert.equal(calls, 1, 'no new attempt-0 fetch');
  assert.equal(timers.scheduled.length, 1, 'the pending retry is still the only timer');
  assert.equal(timers.scheduled[0], pendingRetry, 'and it is the SAME retry, not a restarted chain');

  // The retry fires as scheduled and completes the one-shot.
  await act(async () => {
    timers.fireAll();
    await flush();
  });
  assert.equal(calls, 2);
  assert.equal(added.length, 1);
  assert.equal(added[0].serverId, 'server-1');

  // Further snapshots after completion never poll again.
  await act(async () => {
    renderer.update(
      React.createElement(Harness, { addTerminal, tasks: [{ ...task, updatedAt: 3 }] }),
    );
    await flush();
  });
  assert.equal(calls, 2);
  assert.equal(timers.scheduled.length, 0);

  act(() => renderer.unmount());
});

test('reattach retries after a transient /api/terminals failure and then mounts the matching task pty', async () => {
  let calls = 0;
  const added: Array<Omit<TerminalSpec, 'id'>> = [];
  g.fetch = (url: string) => {
    assert.equal(url, '/api/terminals');
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({
        ok: false,
        status: 503,
        json: () => Promise.resolve({}),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([{ id: 'server-1', cwd: 'C:/wt/task-1' }]),
    });
  };

  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(Harness, {
        addTerminal: (spec) => {
          added.push(spec);
          return 'term-1';
        },
      }),
    );
  });
  await act(async () => {
    await flush();
  });

  assert.equal(calls, 1);
  assert.equal(added.length, 0);
  assert.equal(timers.scheduled.length, 1, 'failed terminal list schedules a retry');
  assert.equal(timers.scheduled[0].delay, TASK_TERMINAL_REATTACH_RETRY_DELAYS_MS[0]);

  await act(async () => {
    timers.fireAll();
    await flush();
  });

  assert.equal(calls, 2);
  assert.deepEqual(added, [
    {
      label: 'reattach me',
      cwd: 'C:/wt/task-1',
      taskId: 'task-1',
      projectPath: 'C:/project-A',
      serverId: 'server-1',
    },
  ]);

  act(() => renderer.unmount());
});
