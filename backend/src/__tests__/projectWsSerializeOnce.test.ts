import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { WebSocketServer } from 'ws';
import { buildProjectSnapshotWss } from '../ws/projectEndpoint.js';
import { buildTasksWss } from '../ws/endpoints/tasks.js';
import { createTask, updateTask } from '../tasks.js';
import { notifyTaskActivity } from '../taskActivityEvents.js';
import { flushProjectNotifications } from '../projectStateManager.js';

// Regression: one broadcast must be JSON.stringify'd once however many
// connections receive it. The endpoint caches the serialized frame by event
// identity, but /ws/tasks and every buildProjectSnapshotWss endpoint wrapped
// the store's shared snapshot in a fresh event object PER CONNECTION, so the
// cache always missed and K open tabs meant K multi-MB stringifies of the
// whole board on every task change.

class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}

function connect(wss: WebSocketServer, project: string, count: number): FakeWs[] {
  const clients: FakeWs[] = [];
  for (let i = 0; i < count; i++) {
    const ws = new FakeWs();
    const req = { url: `/ws/x?project=${encodeURIComponent(project)}` } as IncomingMessage;
    wss.emit('connection', ws, req);
    clients.push(ws);
  }
  return clients;
}

// Yield turns until every client holds `frames` frames (the async handshake
// subscribes, then loads and sends the initial snapshot).
async function waitForFrames(clients: FakeWs[], frames: number): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    if (clients.every((ws) => ws.sent.length >= frames)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`clients never reached ${frames} frame(s): ${clients.map((ws) => ws.sent.length)}`);
}

// Spy (calling through) on JSON.stringify, counting only payloads of `type`.
function countStringifies(t: TestContext, type: string): { count: () => number; restore: () => void } {
  const spy = t.mock.method(JSON, 'stringify');
  return {
    count: () => spy.mock.calls.filter((call) => {
      const arg = call.arguments[0] as { type?: unknown } | null | undefined;
      return arg !== null && typeof arg === 'object' && arg.type === type;
    }).length,
    restore: () => spy.mock.restore(),
  };
}

function assertIdenticalLastFrames(clients: FakeWs[]): string {
  const frames = clients.map((ws) => ws.sent[ws.sent.length - 1]);
  for (const frame of frames) assert.equal(frame, frames[0], 'every client gets byte-identical frames');
  return frames[0]!;
}

test('/ws/tasks: one task-change broadcast is serialized once for 3 clients', async (t) => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-ws-serialize-once-'));
  const wss = buildTasksWss();
  let clients: FakeWs[] = [];
  try {
    const task = await createTask(project, 'before');
    // Drain createTask's own (coalesced) fan-out before anyone connects.
    await flushProjectNotifications();

    clients = connect(wss, project, 3);
    await waitForFrames(clients, 1);

    const tasksFrames = countStringifies(t, 'tasks');
    try {
      await updateTask(task.id, { title: 'after' });
      await flushProjectNotifications();
      await waitForFrames(clients, 2);
      assert.equal(tasksFrames.count(), 1, 'the board snapshot is stringified once, not per client');
    } finally {
      tasksFrames.restore();
    }
    const frame = JSON.parse(assertIdenticalLastFrames(clients));
    assert.equal(frame.type, 'tasks');
    assert.equal(frame.tasks.find((x: { id: string }) => x.id === task.id)?.title, 'after');

    // Transient events (activity / spawn) are wrapped per connection too.
    const activityFrames = countStringifies(t, 'task-activity');
    try {
      notifyTaskActivity({
        projectPath: project,
        taskId: task.id,
        file: path.join(project, 'a.ts'),
        phase: 'start',
        tool: 'Read',
        ts: Date.now(),
      });
      await waitForFrames(clients, 3);
      assert.equal(activityFrames.count(), 1, 'one activity event is stringified once');
    } finally {
      activityFrames.restore();
    }
    assert.equal(JSON.parse(assertIdenticalLastFrames(clients)).type, 'task-activity');
  } finally {
    // Drop the connections' subscriptions on the module-level task cache.
    for (const ws of clients) ws.close();
    wss.close();
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('buildProjectSnapshotWss: one snapshot fan-out is serialized once for 3 clients', async (t) => {
  const project = process.platform === 'win32' ? 'C:\\proj-ws-serialize-once' : '/proj-ws-serialize-once';
  const listeners = new Set<(projectPath: string, snapshot: string[]) => void>();
  const wss = buildProjectSnapshotWss<string[]>({
    messageType: 'things',
    snapshotKey: 'things',
    list: () => [],
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  // A store fan-out: one snapshot object handed to every listener.
  const fanOut = (snapshot: string[]) => {
    for (const listener of [...listeners]) listener(project, snapshot);
  };
  try {
    const clients = connect(wss, project, 3);
    await waitForFrames(clients, 1);
    assert.equal(listeners.size, 3, 'one store subscription per connection');

    const frames = countStringifies(t, 'things');
    try {
      fanOut(['a']);
      assert.equal(frames.count(), 1, 'the snapshot is stringified once, not per client');
      assert.deepEqual(JSON.parse(assertIdenticalLastFrames(clients)), { type: 'things', things: ['a'] });

      // A new snapshot is a new broadcast: serialized afresh, never stale.
      fanOut(['a', 'b']);
      assert.equal(frames.count(), 2);
      assert.deepEqual(JSON.parse(assertIdenticalLastFrames(clients)), { type: 'things', things: ['a', 'b'] });
    } finally {
      frames.restore();
    }
  } finally {
    wss.close();
  }
});
