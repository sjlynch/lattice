// Surviving a backend restart, task Resume: only unaccepted 503 / ECONNREFUSED
// requests are retried, allocating once; a Resume whose agent settled before
// its acknowledgement was lost (network error, 504, ECONNRESET — with or
// without the task-spawned socket event) never allocates a second agent nor
// kills the first, while a later explicit Resume is allowed.
// Shared fixtures: backendRestartResilience.fixture.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Task, TaskSpawnedEvent } from '../api';
import { installManualTimers } from './domDoubles.ts';
import { GitSetupProvider } from '../components/gitSetup/GitSetupProvider.tsx';
import { TerminalsProvider, useTerminals } from '../TerminalsContext.tsx';
import type { Ctx } from '../terminal/terminalTypes';
import { useTaskLifecycleActions } from '../components/taskboard/hooks/useTaskLifecycleActions.ts';
import { useTaskSpawnHandler } from '../components/taskboard/hooks/useTaskSpawnHandler.ts';
import {
  ambiguousFailures,
  deferredVoid,
  FOLDER,
  g,
  installRestartGlobals,
  jsonResponse,
  lostAcknowledgement,
} from './backendRestartResilience.fixture.ts';

installRestartGlobals();

// ----------------------------------------------- task Resume retry path

const resumableTask: Task = {
  id: 't1', title: 'resume me', projectPath: FOLDER,
  status: 'in_progress', createdAt: 0, worktreePath: 'C:/wt/t1',
};

async function mountResumeActions() {
  let actions!: ReturnType<typeof useTaskLifecycleActions>;
  let terminals!: Ctx;
  let handleSpawn!: (event: TaskSpawnedEvent) => void;
  const messages: string[] = [];
  function Harness() {
    terminals = useTerminals();
    handleSpawn = useTaskSpawnHandler(terminals.addTerminal, terminals.closeTerminalsForTask).handleTaskSpawned;
    actions = useTaskLifecycleActions({
      activeFolder: FOLDER,
      tasks: [resumableTask],
      pickRunHarness: () => ({ harness: 'claude' }),
      showError: (message) => { messages.push(message); },
    });
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(GitSetupProvider, {
      children: React.createElement(TerminalsProvider, {
        activeFolder: '', restoreMode: null, children: React.createElement(Harness),
      }),
    }));
  });
  return {
    resume: () => actions.resumeTaskAction(resumableTask),
    spawn: (serverId: string) => handleSpawn({
      taskId: resumableTask.id, title: resumableTask.title, projectPath: FOLDER,
      worktreePath: resumableTask.worktreePath!, command: 'claude', serverId,
    }),
    terminals: () => terminals.terminals,
    messages,
    unmount: async () => { await act(async () => { renderer.unmount(); }); },
  };
}

for (const error of ambiguousFailures) {
  for (const connected of [false, true]) {
    test(`settled Resume with lost acknowledgement (${error.message}, socket ${connected}) allocates once`, async (t) => {
      const timers = installManualTimers();
      t.after(() => timers.restore());
      const acknowledgement = deferredVoid();
      let allocations = 0;
      const deletes: string[] = [];
      const mounted = await mountResumeActions();
      t.after(mounted.unmount);
      g.fetch = async (url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deletes.push(String(url));
          return jsonResponse(200, {});
        }
        assert.ok(String(url).includes('/api/tasks/t1/resume'));
        assert.equal(init?.method, 'POST');
        // Model a completed queue thunk: no dedupe entry remains to prevent
        // a later POST from allocating a fresh agent in this same worktree.
        allocations++;
        if (connected) mounted.spawn(`agent-${allocations}`);
        if (allocations === 1) {
          await acknowledgement.promise;
          return lostAcknowledgement(error);
        }
        return jsonResponse(202, { accepted: true, queued: false });
      };
      let pending!: Promise<void>;
      await act(async () => { pending = mounted.resume(); });
      assert.equal(allocations, 1, 'the first spawn settled before its HTTP response');
      await act(async () => { acknowledgement.resolve(); });
      await act(async () => { timers.fireAll(); });
      await pending;
      assert.equal(allocations, 1, 'advancing the retry delay cannot allocate agent B');
      assert.deepEqual(deletes, [], 'the first successfully resumed agent was never killed');
      assert.deepEqual(mounted.terminals().map((tab) => tab.serverId), connected ? ['agent-1'] : []);
      assert.match(mounted.messages[0], /could not be confirmed/);

      await act(async () => { await mounted.resume(); });
      assert.equal(allocations, 2, 'a later explicit Resume is allowed');
      assert.deepEqual(mounted.terminals().map((tab) => tab.serverId), connected ? ['agent-2'] : []);
      assert.deepEqual(deletes, connected ? ['/api/terminals/agent-1'] : []);
    });
  }
}

test('Resume retries only unaccepted 503/ECONNREFUSED requests before allocating once', async (t) => {
  const timers = installManualTimers();
  t.after(() => timers.restore());
  const mounted = await mountResumeActions();
  t.after(mounted.unmount);
  let posts = 0;
  let allocations = 0;
  g.fetch = async (url: string) => {
    assert.ok(String(url).includes('/api/tasks/t1/resume'));
    posts++;
    if (posts === 1) return jsonResponse(503, { error: 'backend-restarting' });
    if (posts === 2) return jsonResponse(502, { error: '[api-proxy]: ECONNREFUSED' });
    allocations++;
    mounted.spawn('agent-1');
    return jsonResponse(202, { accepted: true, queued: false });
  };
  let pending!: Promise<void>;
  await act(async () => { pending = mounted.resume(); });
  for (const delay of [1_000, 2_000]) {
    assert.deepEqual(timers.scheduled.map((timer) => timer.delay), [delay]);
    assert.equal(allocations, 0);
    await act(async () => { timers.fireAll(); });
  }
  await pending;
  assert.equal(posts, 3);
  assert.equal(allocations, 1);
  assert.deepEqual(mounted.messages, []);
  assert.deepEqual(mounted.terminals().map((tab) => tab.serverId), ['agent-1']);
});
