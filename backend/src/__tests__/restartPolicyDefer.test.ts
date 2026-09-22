import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyDeferAction,
  createRestartPolicy,
  describeRunLocks,
  heldRunLockLabels,
  heldRunLocks,
  processStartTimeMs,
  repoOperationInFlight,
  workflowRunInFlight,
  DEFERRED_RESTART_POLL_MS,
  HOLD_LOG_THROTTLE_MS,
  MAX_DEFER_MS,
  PROCESS_START_FUZZ_MS,
} from '../../scripts/dev/restartPolicy.mjs';

// Regression for: the dev runner force-restarted the backend after 15 min while
// a workflow's Merge control step was legitimately holding the run.lock (waiting
// for its tasks to commit — routinely > 15 min). That wiped the in-memory
// workflow run, stranded its completed-but-unmerged tasks, and cascaded the
// queue onto the next workflow. A live `workflow-*` control-step lock must be
// EXEMPT from the force-restart backstop; a short, re-runnable merge-run lock
// still gets forced.

test('classifyDeferAction: nothing deferred → idle', () => {
  assert.equal(
    classifyDeferAction({ deferredSince: 0, now: 1000, operationInFlight: true, workflowInFlight: true }),
    'idle',
  );
});

test('classifyDeferAction: lock cleared → apply the deferred restart', () => {
  assert.equal(
    classifyDeferAction({ deferredSince: 1, now: 1000, operationInFlight: false, workflowInFlight: false }),
    'apply',
  );
});

test('classifyDeferAction: a live workflow past the window is HELD, never forced', () => {
  const deferredSince = 1;
  const now = deferredSince + MAX_DEFER_MS + 60 * 60 * 1000; // an hour past the backstop
  assert.equal(
    classifyDeferAction({ deferredSince, now, operationInFlight: true, workflowInFlight: true }),
    'hold-workflow',
  );
});

test('classifyDeferAction: a non-workflow op past the window IS forced', () => {
  const deferredSince = 1;
  const now = deferredSince + MAX_DEFER_MS + 1;
  assert.equal(
    classifyDeferAction({ deferredSince, now, operationInFlight: true, workflowInFlight: false }),
    'force',
  );
});

test('classifyDeferAction: a non-workflow op within the window is held', () => {
  const deferredSince = 1;
  const now = deferredSince + MAX_DEFER_MS - 1;
  assert.equal(
    classifyDeferAction({ deferredSince, now, operationInFlight: true, workflowInFlight: false }),
    'hold',
  );
});

test('heldRunLockLabels / workflowRunInFlight classify live locks by label and skip dead PIDs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-restartpolicy-'));
  try {
    const write = async (hash: string, body: unknown) => {
      const d = path.join(dir, hash);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, 'run.lock'), JSON.stringify(body), 'utf8');
    };
    await write('aaaaaaaaaaaa', { pid: 1111, label: 'workflow-merge:wfrun_x' }); // live workflow
    await write('bbbbbbbbbbbb', { pid: 2222, label: 'merge-run' }); // live merge run
    await write('cccccccccccc', { pid: 3333, label: 'workflow-push:wfrun_y' }); // DEAD workflow

    // 1111/2222 alive, 3333 dead.
    const isPidAlive = (pid: number) => pid === 1111 || pid === 2222;
    const opts = { perProjectDir: dir, isPidAlive };

    const labels = heldRunLockLabels(opts).sort();
    assert.deepEqual(labels, ['merge-run', 'workflow-merge:wfrun_x'], 'dead-PID lock is excluded');
    assert.equal(repoOperationInFlight(opts), true);
    assert.equal(workflowRunInFlight(opts), true, 'a live workflow lock is detected');

    // Now only a live merge-run + the DEAD workflow lock → no LIVE workflow.
    const onlyMergeAlive = (pid: number) => pid === 2222;
    const opts2 = { perProjectDir: dir, isPidAlive: onlyMergeAlive };
    assert.equal(repoOperationInFlight(opts2), true);
    assert.equal(
      workflowRunInFlight(opts2),
      false,
      'a dead-PID workflow lock does not count — the backstop may force a merge-run restart',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---- holder identity (2026-09-22: a 15-min deferral with nothing in flight) --
//
// `heldRunLocks` used to count any lock whose PID answered `kill(0)`. A lock
// leaked by a dead backend whose PID the OS recycled therefore deferred every
// restart for the full MAX_DEFER_MS, and no line ever named it. The scan now
// applies the backend's own liveness rules (liveness.ts): same host, live PID,
// AND a process start time no newer than the lock's `startedAt`.

async function lockDir(t: { after(fn: () => Promise<void>): void }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-restartpolicy-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const write = async (hash: string, body: unknown) => {
    const d = path.join(dir, hash);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'run.lock'), JSON.stringify(body), 'utf8');
  };
  return { dir, write };
}

test('heldRunLocks ignores a live PID whose process started AFTER the lock was written (PID reuse)', async (t) => {
  const { dir, write } = await lockDir(t);
  const lockedAt = 1_700_000_000_000;
  await write('recycled0000', { pid: 4242, hostname: os.hostname(), startedAt: lockedAt, label: 'merge-run', ownerId: 'a' });
  await write('genuine00000', { pid: 4343, hostname: os.hostname(), startedAt: lockedAt, label: 'merge-run', ownerId: 'b' });
  await write('unknown00000', { pid: 4444, hostname: os.hostname(), startedAt: lockedAt, label: 'manual-merge', ownerId: 'c' });
  const startTimes: Record<number, number | null> = {
    4242: lockedAt + 60 * 60 * 1000, // this process is an hour younger than the lock: not the holder
    4343: lockedAt - 5000, // started before the lock: genuine holder
    4444: null, // uncertain: assume alive, like the backend does
  };
  const locks = heldRunLocks({
    perProjectDir: dir,
    isPidAlive: () => true,
    readProcessStartTime: (pid) => startTimes[pid] ?? null,
    startTimeCache: new Map(),
  });
  assert.deepEqual(
    locks.map((l) => l.hash).sort(),
    ['genuine00000', 'unknown00000'],
    'the recycled-PID lock must not count as an in-flight operation',
  );
  assert.equal(locks.find((l) => l.hash === 'genuine00000')?.startedAt, lockedAt);
});

test('heldRunLocks tolerates the fuzz between startedAt and the OS start time', async (t) => {
  const { dir, write } = await lockDir(t);
  const lockedAt = 1_700_000_000_000;
  await write('fuzzy0000000', { pid: 1, hostname: os.hostname(), startedAt: lockedAt, label: 'merge-run' });
  const within = heldRunLocks({
    perProjectDir: dir, isPidAlive: () => true, startTimeCache: new Map(),
    readProcessStartTime: () => lockedAt + PROCESS_START_FUZZ_MS - 1,
  });
  assert.equal(within.length, 1, 'inside the fuzz window the PID is still the holder');
  const beyond = heldRunLocks({
    perProjectDir: dir, isPidAlive: () => true, startTimeCache: new Map(),
    readProcessStartTime: () => lockedAt + PROCESS_START_FUZZ_MS + 1,
  });
  assert.equal(beyond.length, 0);
});

test('heldRunLocks ignores a lock written on another host', async (t) => {
  const { dir, write } = await lockDir(t);
  await write('remote000000', { pid: 5151, hostname: `${os.hostname()}-elsewhere`, startedAt: 1, label: 'merge-run' });
  await write('local0000000', { pid: 5252, hostname: os.hostname(), startedAt: 1, label: 'merge-run' });
  await write('legacy000000', { pid: 5353, startedAt: 1, label: 'merge-run' }); // no hostname: assume local
  const opts = {
    perProjectDir: dir,
    isPidAlive: () => true,
    readProcessStartTime: () => null,
    startTimeCache: new Map<string, number | null>(),
  };
  assert.deepEqual(heldRunLocks(opts).map((l) => l.hash).sort(), ['legacy000000', 'local0000000']);
  assert.deepEqual(heldRunLockLabels(opts), ['merge-run', 'merge-run']);
});

test('heldRunLocks probes a process start time ONCE per lock body, never per poll', async (t) => {
  const { dir, write } = await lockDir(t);
  const body = { pid: 6161, hostname: os.hostname(), startedAt: 1_700_000_000_000, label: 'merge-run', ownerId: 'gen-1' };
  await write('cached000000', body);
  let probes = 0;
  const cache = new Map<string, number | null>();
  const opts = {
    perProjectDir: dir,
    isPidAlive: () => true,
    readProcessStartTime: () => { probes += 1; return body.startedAt - 1000; },
    startTimeCache: cache,
  };
  for (let i = 0; i < 5; i++) assert.equal(heldRunLocks(opts).length, 1);
  assert.equal(probes, 1, 'the 3 s poll must not re-spawn the probe for the same lock');
  assert.equal(cache.size, 1);

  // A new generation of the lock (new run, new ownerId) is a new body: one more probe.
  await write('cached000000', { ...body, ownerId: 'gen-2' });
  heldRunLocks(opts);
  assert.equal(probes, 2);
  assert.equal(cache.size, 1, 'the vanished generation is dropped from the cache');

  // The lock is gone: nothing is probed and the cache is emptied.
  await fs.rm(path.join(dir, 'cached000000', 'run.lock'));
  assert.equal(heldRunLocks(opts).length, 0);
  assert.equal(probes, 2);
  assert.equal(cache.size, 0);
});

test('processStartTimeMs reports THIS process as started no later than now, and a bogus pid as unknown', () => {
  // The real probe (PowerShell on win32, `ps` on POSIX): the whole PID-reuse
  // defence rests on it actually answering on this platform.
  const started = processStartTimeMs(process.pid);
  assert.ok(typeof started === 'number', `expected a start time for pid ${process.pid}, got ${String(started)}`);
  const approx = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(started - approx) < 60 * 1000, `start time ${started} is not near ${approx}`);
  assert.equal(processStartTimeMs(-1), null);
  assert.equal(processStartTimeMs(0), null);
});

test('describeRunLocks names hash, label, pid and startedAt for the log lines', () => {
  assert.equal(describeRunLocks([]), 'no run.lock');
  assert.equal(
    describeRunLocks([{ hash: 'abc123def456', label: 'merge-run', pid: 77, startedAt: Date.UTC(2026, 8, 22, 10, 0, 0) }]),
    'abc123def456 label=merge-run pid=77 startedAt=2026-09-22T10:00:00.000Z',
  );
  assert.equal(describeRunLocks([{ hash: 'h', label: '', pid: 1, startedAt: 0 }]), 'h label=? pid=1 startedAt=?');
});

// ---- the poll: no scans while idle, one scan per tick while deferred, holder logged ---

test('the deferred-restart poll reads no run.lock while nothing is deferred, and scans ONCE per tick otherwise', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let scans = 0;
  let locks: ReturnType<typeof heldRunLocks> = [];
  let clock = 1_000_000;
  const restarts: string[] = [];
  const logs: string[] = [];
  t.mock.method(console, 'log', (msg: unknown) => { logs.push(String(msg)); });
  const policy = createRestartPolicy({
    restartBackend: (reason) => { restarts.push(reason); return true; },
    readHeldRunLocks: () => { scans += 1; return locks; },
    readNewestDistMtime: () => 100,
    now: () => clock,
  });
  policy.resetDistBaseline();
  policy.startDeferredPoll();

  for (let i = 0; i < 10; i++) { clock += DEFERRED_RESTART_POLL_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS); }
  assert.equal(scans, 0, 'idle poll ticks must not touch the filesystem');

  // A real dist/ change while a merge run holds the lock: deferred (one scan).
  locks = [{ hash: 'deadbeef0000', label: 'merge-run', pid: 99, startedAt: clock - 1000 }];
  policy.onDistChanged(true);
  assert.equal(scans, 1);
  assert.equal(restarts.length, 0);
  assert.match(logs.at(-1) ?? '', /deadbeef0000 label=merge-run pid=99 startedAt=/, 'the defer line names the holder');

  clock += DEFERRED_RESTART_POLL_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(scans, 2, 'exactly one scan per deferred tick (it used to be two)');

  // Lock cleared: applied; back to idle, so no further scans.
  locks = [];
  clock += DEFERRED_RESTART_POLL_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(scans, 3);
  assert.deepEqual(restarts, ['run finished — applying deferred restart']);
  clock += DEFERRED_RESTART_POLL_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(scans, 3, 'idle again: no scan');
  policy.stopDeferredPoll();
});

test('a held or forced restart logs WHICH lock is holding it (throttled hold line, named force line)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let clock = 5_000_000;
  const lock = { hash: 'cafe00000000', label: 'manual-merge', pid: 4321, startedAt: clock - 10_000 };
  const restarts: string[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  t.mock.method(console, 'log', (msg: unknown) => { logs.push(String(msg)); });
  t.mock.method(console, 'warn', (msg: unknown) => { warns.push(String(msg)); });
  const policy = createRestartPolicy({
    restartBackend: (reason) => { restarts.push(reason); return true; },
    readHeldRunLocks: () => [lock],
    readNewestDistMtime: () => 100,
    now: () => clock,
  });
  policy.resetDistBaseline();
  policy.startDeferredPoll();
  policy.onDistChanged(true);
  const deferLines = logs.filter((l) => l.includes('deferring'));
  assert.equal(deferLines.length, 1);
  assert.match(deferLines[0], /cafe00000000 label=manual-merge pid=4321 startedAt=/);

  const holdLine = (l: string) => l.includes('still deferred');
  // Under a minute: the defer line already named the holder; no hold line yet.
  clock += DEFERRED_RESTART_POLL_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(logs.filter(holdLine).length, 0);
  // Past the throttle: exactly one hold line naming the holder, then quiet again.
  clock += HOLD_LOG_THROTTLE_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  const holds = logs.filter(holdLine);
  assert.equal(holds.length, 1);
  assert.match(holds[0], /cafe00000000 label=manual-merge pid=4321/);
  clock += DEFERRED_RESTART_POLL_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.equal(logs.filter(holdLine).length, 1, 'the hold line is throttled to once a minute');

  // Past the backstop: the force line names the holder too.
  clock += MAX_DEFER_MS; t.mock.timers.tick(DEFERRED_RESTART_POLL_MS);
  assert.deepEqual(restarts, ['forced after a long defer']);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /forcing it/);
  assert.match(warns[0], /cafe00000000 label=manual-merge pid=4321 startedAt=/);
  policy.stopDeferredPoll();
});
