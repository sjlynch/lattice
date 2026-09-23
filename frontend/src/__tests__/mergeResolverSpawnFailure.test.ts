import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { installGlobal } from './domDoubles.ts';
import { useTaskMergeActions } from '../components/taskboard/hooks/useTaskMergeActions.ts';
import type { Task } from '../api';
import type { AddTerminalSpec } from '../terminal/terminalTypes';

// A manual ▶ Merge that conflicts gets its resolver pty PRE-SPAWNED by the
// backend (the spawn chokepoint applies the MCP scope, system prompt and
// registry record). When that pre-spawn fails the response has no `serverId`;
// the board used to open the tab anyway, which started the resolver over a
// serverless `/ws/terminal` and bypassed all of it. It must toast instead.

const task = { id: 't1', title: 'Fix the thing', projectPath: 'C:/p', status: 'ready_to_merge' } as Task;

async function runMerge(body: object) {
  const added: AddTerminalSpec[] = [];
  const errors: string[] = [];
  const restore = [
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('fetch', () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })),
  ];
  let merge!: (t: Task) => Promise<boolean>;
  function Probe() {
    merge = useTaskMergeActions({
      activeFolder: 'C:/p',
      tasks: [task],
      mergeRun: null,
      addTerminal: (spec) => { added.push(spec); return spec.id ?? 'x'; },
      moveTask: async () => {},
      showError: (m) => { errors.push(m); },
    }).mergeTaskAction;
    return null;
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Probe)); });
  try {
    const merged = await merge(task);
    return { merged, added, errors };
  } finally {
    act(() => renderer.unmount());
    for (const reset of restore.reverse()) reset();
  }
}

test('a conflict whose resolver failed to pre-spawn toasts and opens no terminal', async () => {
  const { merged, added, errors } = await runMerge({
    merged: false, conflict: true, command: 'claude "resolve"', cwd: 'C:/wt', resolverError: 'terminal-server down',
  });
  assert.equal(merged, false);
  assert.equal(added.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not be started: terminal-server down/);
});

test('a pre-spawned resolver still opens its tab', async () => {
  const { added, errors } = await runMerge({
    merged: false, conflict: true, command: 'claude "resolve"', cwd: 'C:/wt', serverId: 'pty-1', terminalId: 'tab-1',
  });
  assert.equal(errors.length, 0);
  assert.equal(added.length, 1);
  assert.equal(added[0].serverId, 'pty-1');
});
