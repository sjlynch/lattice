import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { Ctx } from '../terminal/terminalTypes';
import type { TaskSpawnedEvent } from '../api';
import { TerminalsProvider, useTerminals } from '../TerminalsContext.tsx';
import { useTaskSpawnHandler } from '../components/taskboard/hooks/useTaskSpawnHandler.ts';
import { installGlobal } from './domDoubles.ts';

function spawnEvent(overrides: Partial<TaskSpawnedEvent> = {}): TaskSpawnedEvent {
  return {
    taskId: 't1',
    title: 'resume me',
    command: 'claude',
    worktreePath: '/wt/t1',
    serverId: 'new',
    projectPath: '/proj',
    ...overrides,
  };
}

// Drives the real TerminalsProvider + the task-spawned handler so the assertion
// is the actual close-then-add composition, not a re-implementation of it.
function withHandler(
  run: (ctx: () => Ctx, handle: (ev: TaskSpawnedEvent) => void, deletes: string[]) => void,
): void {
  const deletes: string[] = [];
  const store = new Map<string, string>();
  const restores = [
    // tsx compiles the app's .tsx with the classic JSX runtime, so components
    // emit React.createElement without importing React — expose it globally.
    installGlobal('React', React),
    installGlobal('IS_REACT_ACT_ENVIRONMENT', true),
    installGlobal('sessionStorage', {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }),
    installGlobal(
      'fetch',
      ((url: string, init?: { method?: string }) => {
        if (init?.method === 'DELETE') deletes.push(url);
        return Promise.resolve({ ok: true });
      }) as unknown as typeof fetch,
    ),
  ];

  let ctx: Ctx | null = null;
  let handle: ((ev: TaskSpawnedEvent) => void) | null = null;
  function Capture() {
    ctx = useTerminals();
    // The handler needs the batched closeTerminalsForTask so a stale tab is
    // dropped in one setState before the fresh pty mounts.
    handle = useTaskSpawnHandler(ctx.addTerminal, ctx.closeTerminalsForTask)
      .handleTaskSpawned;
    return null;
  }

  let renderer!: ReturnType<typeof TestRenderer.create>;
  try {
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(
          TerminalsProvider,
          null,
          React.createElement(Capture),
        ),
      );
    });
    run(() => ctx!, (ev) => handle!(ev), deletes);
  } finally {
    act(() => renderer.unmount());
    for (const restore of restores.reverse()) restore();
  }
}

test('task-spawned replaces a stale terminal for the same task instead of duplicating it', () => {
  withHandler((ctx, handle, deletes) => {
    // The pre-resume worktree-agent tab: still in the sidebar (its session
    // ended without committing, so the task stays in_progress and cleanup
    // never closed it).
    act(() => {
      ctx().addTerminal({
        label: 'resume me',
        cwd: '/wt/t1',
        taskId: 't1',
        serverId: 'old',
        projectPath: '/proj',
      });
    });
    assert.equal(ctx().terminals.length, 1);

    // Resume re-spawns the pty with a NEW serverId and emits task-spawned.
    act(() => handle(spawnEvent({ serverId: 'new' })));

    const forT1 = ctx().terminals.filter((t) => t.taskId === 't1');
    assert.equal(forT1.length, 1, 'exactly one terminal for the task — not two');
    assert.equal(
      forT1[0].serverId,
      'new',
      'the newly-delivered serverId is authoritative',
    );
    assert.deepEqual(
      deletes,
      ['/api/terminals/old'],
      'the stale pty is DELETEd; the fresh one is not',
    );
  });
});

test('task-spawned for a task with no existing terminal just mounts one (normal run)', () => {
  withHandler((ctx, handle, deletes) => {
    act(() => handle(spawnEvent({ taskId: 't2', serverId: 's2' })));

    const forT2 = ctx().terminals.filter((t) => t.taskId === 't2');
    assert.equal(forT2.length, 1);
    assert.equal(forT2[0].serverId, 's2');
    assert.deepEqual(deletes, [], 'nothing to close, so no DELETE fires');
  });
});

test('task-spawned leaves a sibling task’s terminal untouched', () => {
  withHandler((ctx, handle, deletes) => {
    act(() => {
      ctx().addTerminal({
        label: 'other',
        cwd: '/wt/t9',
        taskId: 't9',
        serverId: 's9',
        projectPath: '/proj',
      });
      ctx().addTerminal({
        label: 'resume me',
        cwd: '/wt/t1',
        taskId: 't1',
        serverId: 'old',
        projectPath: '/proj',
      });
    });

    act(() => handle(spawnEvent({ serverId: 'new' })));

    assert.deepEqual(
      ctx()
        .terminals.map((t) => `${t.taskId}:${t.serverId}`)
        .sort(),
      ['t1:new', 't9:s9'],
      'only the resumed task’s tab is replaced; the sibling survives',
    );
    assert.deepEqual(deletes, ['/api/terminals/old']);
  });
});
