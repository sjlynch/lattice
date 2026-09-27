import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { installGlobal } from './domDoubles.ts';
import { useTaskMergeActions } from '../components/taskboard/hooks/useTaskMergeActions.ts';
import type { Task } from '../api';
import type { AddTerminalSpec, TerminalSpec } from '../terminal/terminalTypes';

// The red "conflict" pill (and Merge) on a task whose resolver is still
// working used to POST /merge again: the backend spawned a SECOND resolver into
// the same worktree and the board added another tab, so two Claudes edited and
// committed the same merge. It must focus the running resolver instead. And a
// double-click on Merge is one request, not a second that 409s into a toast.

const conflicted = { id: 't1', title: 'Fix the thing', projectPath: 'C:/p', status: 'ready_to_merge', conflict: true } as Task;
const plain = { ...conflicted, conflict: false } as Task;

const resolverTab: TerminalSpec = {
  id: 'tab-live', serverId: 'pty-live', label: 'merge:Fix', cwd: 'C:/wt', taskId: 't1', kind: 'merge', status: 'live',
};

const conflictBody = { merged: false, conflict: true, command: 'claude "resolve"', cwd: 'C:/wt', serverId: 'pty-new', terminalId: 'tab-new' };

async function setup(terminals: TerminalSpec[], respond: () => Promise<unknown> = () => Promise.resolve(conflictBody)) {
  const posts: string[] = [];
  const added: { spec: AddTerminalSpec; focus?: boolean }[] = [];
  const focused: string[] = [];
  const closed: { taskId: string; keep?: { id?: string; serverId?: string } }[] = [];
  const errors: string[] = [];
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('fetch', (url: string) => {
      posts.push(url);
      return respond().then((body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }));
    }),
  ];
  let merge!: (t: Task) => Promise<boolean>;
  function Probe() {
    merge = useTaskMergeActions({
      activeFolder: 'C:/p',
      tasks: [conflicted],
      mergeRun: null,
      addTerminal: (spec, focus) => { added.push({ spec, focus }); return spec.id ?? 'x'; },
      moveTask: async () => {},
      showError: (m) => { errors.push(m); },
      terminals,
      focusTerminal: (id) => { focused.push(id); },
      closeTerminalsForTask: (taskId, keep) => { closed.push({ taskId, keep }); },
    }).mergeTaskAction;
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });
  const teardown = () => {
    act(() => renderer.unmount());
    for (const reset of restore.reverse()) reset();
  };
  return { merge: (t: Task) => merge(t), posts, added, focused, closed, errors, teardown };
}

test('the conflict pill on a task with a live resolver focuses it and POSTs nothing', async () => {
  const s = await setup([resolverTab]);
  try {
    assert.equal(await s.merge(conflicted), false);
    assert.equal(s.posts.length, 0, 'a second /merge would spawn a second resolver');
    assert.deepEqual(s.focused, ['tab-live']);
    assert.equal(s.added.length, 0);
  } finally {
    s.teardown();
  }
});

test('a never-activated resolver tab (no status yet) still counts as live', async () => {
  const s = await setup([{ ...resolverTab, status: undefined }]);
  try {
    await s.merge(conflicted);
    assert.equal(s.posts.length, 0);
    assert.deepEqual(s.focused, ['tab-live']);
  } finally {
    s.teardown();
  }
});

test('an exited resolver tab does not block a new resolver, and is replaced', async () => {
  const s = await setup([{ ...resolverTab, status: 'exited', exitCode: 0 }]);
  try {
    await s.merge(conflicted);
    assert.equal(s.posts.length, 1);
    assert.equal(s.focused.length, 0);
    assert.deepEqual(s.closed, [{ taskId: 't1', keep: { id: 'tab-new', serverId: 'pty-new' } }]);
    assert.equal(s.added.length, 1);
    assert.equal(s.added[0].spec.serverId, 'pty-new');
  } finally {
    s.teardown();
  }
});

test('Merge after a resolver gave up (conflict flag cleared) retries instead of refocusing', async () => {
  const s = await setup([resolverTab]);
  try {
    await s.merge(plain);
    assert.equal(s.posts.length, 1);
    assert.equal(s.focused.length, 0);
  } finally {
    s.teardown();
  }
});

test('a resolver the backend handed back is focused', async () => {
  const s = await setup([], () => Promise.resolve({ ...conflictBody, serverId: 'pty-live', terminalId: 'tab-live', existingResolver: true }));
  try {
    await s.merge(conflicted);
    assert.equal(s.added.length, 1);
    assert.equal(s.added[0].focus, true);
    assert.deepEqual(s.closed[0].keep, { id: 'tab-live', serverId: 'pty-live' });
  } finally {
    s.teardown();
  }
});

test('two synchronous merge calls make exactly one request', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const s = await setup([], () => gate.then(() => ({ merged: true })));
  try {
    const first = s.merge(plain);
    const second = s.merge(plain);
    assert.equal(await second, false);
    release();
    assert.equal(await first, true);
    assert.equal(s.posts.length, 1);
    assert.equal(s.errors.length, 0);
    // Once settled, a later click goes through again.
    await s.merge(plain);
    assert.equal(s.posts.length, 2);
  } finally {
    s.teardown();
  }
});
