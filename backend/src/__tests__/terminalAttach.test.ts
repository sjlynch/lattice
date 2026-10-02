import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { attachTerminal } from '../terminal/attach.js';
import { broadcastToSubscribers } from '../terminal/broadcast.js';
import { addSession, deleteSession, getSession } from '../terminal/sessionStore.js';
import { ScrollbackStore } from '../terminal/scrollbackStore.js';
import { TerminalOutputFacts } from '../terminal/outputFacts.js';
import type { Session } from '../terminal/sessionTypes.js';

// attachTerminal against a fake pty + fake ws, no real shell: replay-on-attach
// ordering (history, then the live frames that arrived while the replay was
// being read — nothing duplicated, nothing reordered), session_lost for an
// unknown id, subscriber removal on close, and the input/resize/kill relay.

type FakeWs = {
  ws: WebSocket;
  emitter: EventEmitter;
  sent: () => Array<{ type: string; data?: string; id?: string; cols?: number; rows?: number; replayed?: boolean }>;
  closed: () => boolean;
  message: (msg: unknown) => void;
};

function fakeWs(): FakeWs {
  const emitter = new EventEmitter();
  const raw: string[] = [];
  let closed = false;
  const obj = Object.assign(emitter, {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send(d: string) { raw.push(d); },
    close() { closed = true; (obj as { readyState: number }).readyState = 3; emitter.emit('close'); },
    terminate() { closed = true; (obj as { readyState: number }).readyState = 3; emitter.emit('close'); },
  });
  return {
    ws: obj as unknown as WebSocket,
    emitter,
    sent: () => raw.map((r) => JSON.parse(r)),
    closed: () => closed,
    message: (msg) => emitter.emit('message', Buffer.from(JSON.stringify(msg))),
  };
}

type FakePty = { pty: pty.IPty; written: string[]; resizes: Array<[number, number]>; kills: () => number };

function fakePty(): FakePty {
  const written: string[] = [];
  const resizes: Array<[number, number]> = [];
  let kills = 0;
  const obj = {
    pid: 0, // falsy: killProcessTreeWindows is a no-op, nothing real is signalled
    cols: 80,
    rows: 24,
    process: 'fake',
    handleFlowControl: false,
    write: (d: string) => { written.push(d); },
    resize: (c: number, r: number) => { resizes.push([c, r]); },
    kill: () => { kills += 1; },
    onData: () => ({ dispose() {} }),
    onExit: () => ({ dispose() {} }),
    pause() {},
    resume() {},
    clear() {},
  };
  return { pty: obj as unknown as pty.IPty, written, resizes, kills: () => kills };
}

let n = 0;
async function makeSession(): Promise<{ session: Session; pty: FakePty; dir: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lattice-attach-'));
  const id = `tty_attach_${++n}`;
  const p = fakePty();
  const session: Session = {
    id,
    pty: p.pty,
    scrollback: new ScrollbackStore(id, { dir }),
    cols: 80,
    rows: 24,
    cwd: dir,
    shell: 'fake',
    projectPath: dir,
    subscribers: new Set(),
    createdAt: Date.now(),
    lastOutputAt: Date.now(),
    outputFacts: new TerminalOutputFacts(),
    killing: false,
  };
  addSession(session);
  return { session, pty: p, dir };
}

async function cleanup(session: Session, dir: string): Promise<void> {
  deleteSession(session.id);
  await fsp.rm(dir, { recursive: true, force: true });
}

// The pty produced output: what sessionLifecycle's onData does, minus the facts.
function ptyOutput(session: Session, data: string): void {
  session.scrollback.append(data);
  broadcastToSubscribers(session.subscribers, JSON.stringify({ type: 'data', data }));
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition did not settle');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('replay on attach: history first, then live frames that arrived during the read, each byte once', async () => {
  const { session, dir } = await makeSession();
  ptyOutput(session, 'history-1\n');
  ptyOutput(session, 'history-2\n');
  const c = fakeWs();
  attachTerminal(c.ws, { id: session.id });
  assert.ok(session.subscribers.has(c.ws), 'subscribed before the replay is read');
  assert.equal(c.sent()[0]?.type, 'attached');
  assert.equal(c.sent()[0]?.replayed, true);
  // The replay read is in flight (nothing async has run yet): live output now.
  ptyOutput(session, 'live-1\n');
  ptyOutput(session, 'live-2\n');
  assert.equal(c.sent().length, 1, 'live frames are held until the replay is out');
  await until(() => c.sent().length >= 4);
  const frames = c.sent();
  assert.deepEqual(frames.slice(1).map((f) => f.data), ['history-1\nhistory-2\n', 'live-1\n', 'live-2\n']);
  assert.equal(frames[1].replayed, true, 'history must not generate fresh terminal-query input');
  assert.equal(frames[2].replayed, undefined, 'live queries still get answered');
  // Frames after the flush flow straight through.
  ptyOutput(session, 'live-3\n');
  assert.equal(c.sent().at(-1)?.data, 'live-3\n');
  await cleanup(session, dir);
});

test('a failed replay read still releases the held live frames (no unhandled rejection)', async () => {
  const { session, dir } = await makeSession();
  session.scrollback.replayAsync = () => Promise.reject(new Error('EIO'));
  const c = fakeWs();
  attachTerminal(c.ws, { id: session.id });
  ptyOutput(session, 'live-1\n');
  await until(() => c.sent().length >= 2);
  assert.deepEqual(c.sent().slice(1).map((f) => f.data), ['', 'live-1\n']);
  assert.equal(c.sent()[1].replayed, true, 'even a failed/empty replay has an explicit boundary');
  ptyOutput(session, 'live-2\n');
  assert.equal(c.sent().at(-1)?.data, 'live-2\n', 'the subscriber is no longer held');
  await cleanup(session, dir);
});

test('an unknown id answers session_lost, closes, and never spawns', async () => {
  const c = fakeWs();
  attachTerminal(c.ws, { id: 'tty_does_not_exist' });
  assert.equal(c.sent()[0]?.type, 'session_lost');
  assert.ok(c.closed());
  assert.equal(getSession('tty_does_not_exist'), undefined);
});

test('a client close drops the subscriber but leaves the session alive', async () => {
  const { session, dir } = await makeSession();
  const c = fakeWs();
  attachTerminal(c.ws, { id: session.id });
  await until(() => c.sent().length >= 1);
  c.ws.close();
  assert.ok(!session.subscribers.has(c.ws));
  assert.equal(getSession(session.id), session, 'the pty is not killed on disconnect');
  assert.equal(session.killing, false);
  await cleanup(session, dir);
});

test('input is written to the pty; resize is applied only for positive-integer sizes; kill goes through killSession', async () => {
  const { session, pty, dir } = await makeSession();
  const c = fakeWs();
  attachTerminal(c.ws, { id: session.id, cols: 0, rows: -5 });
  assert.deepEqual(pty.resizes, [], 'bad attach sizes are ignored');
  c.message({ type: 'input', data: 'ls\r' });
  assert.deepEqual(pty.written, ['ls\r']);
  c.message({ type: 'resize', cols: 1.5, rows: 40 });
  c.message({ type: 'resize', cols: 'x', rows: 40 });
  c.message({ type: 'resize', cols: 100, rows: 0 });
  assert.deepEqual(pty.resizes, []);
  c.message({ type: 'resize', cols: 100, rows: 40 });
  assert.deepEqual(pty.resizes, [[100, 40]]);
  assert.equal(session.cols, 100);
  assert.equal(session.rows, 40);
  c.message({ type: 'kill' });
  assert.equal(pty.kills(), 1);
  assert.equal(session.killing, true, 'the killing guard is set — a second kill is a no-op');
  c.message({ type: 'kill' });
  assert.equal(pty.kills(), 1);
  await cleanup(session, dir);
});

test('a valid attach size that differs from the session is applied on attach', async () => {
  const { session, pty, dir } = await makeSession();
  const c = fakeWs();
  attachTerminal(c.ws, { id: session.id, cols: 132, rows: 50 });
  assert.deepEqual(pty.resizes, [[132, 50]]);
  await cleanup(session, dir);
});

test('a frame that parses to a non-object (null, number, array, string) is ignored, not thrown', async () => {
  const { session, pty, dir } = await makeSession();
  const c = fakeWs();
  attachTerminal(c.ws, { id: session.id });
  for (const frame of ['null', '42', '[]', '"x"', 'true']) {
    assert.doesNotThrow(() => c.emitter.emit('message', Buffer.from(frame)), `frame ${frame}`);
  }
  assert.deepEqual(pty.written, []);
  assert.deepEqual(pty.resizes, []);
  assert.equal(pty.kills(), 0);
  assert.equal(getSession(session.id), session, 'the session is untouched');
  // The socket still works afterwards.
  c.message({ type: 'input', data: 'ok' });
  assert.deepEqual(pty.written, ['ok']);
  await cleanup(session, dir);
});
