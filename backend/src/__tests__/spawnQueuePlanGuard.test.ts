// The plan guard (spawnQueue/planGuard.ts): while a Claude or Codex plan has
// used at least the threshold of its 5-hour or weekly window, NEW fan-out
// spawns of that harness wait in the queue instead of running into the limit
// (or, for Codex, onto paid credits — 2026-10-19 drew them overnight). It never
// holds Pi, priority/interactive spawns, model-only windows, an unreadable
// plan, or a window whose reset time has passed; and a held request is never
// dropped — it starts once the guard lets go. The global setting is validated
// (0–100, 0 = off) and applied to the live queue without a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { buildGlobalSettingsRouter } from '../routes/globalSettings.js';
import { PlanGuard, REFRESH_MS } from '../spawnQueue/planGuard.js';
import { queueState } from '../spawnQueue/state.js';
import { batchAdmissionHold, enqueueSpawn, getSpawnQueueSnapshot, setSpawnQueuePlanGuard } from '../spawnQueue.js';
import type { PlanUsageReport } from '../planUsage/types.js';

const HOUR = 3600_000;
const T0 = Date.parse('2026-10-22T20:00:00Z');

function report(claude: number, codex = 10, opts: { weekOpus?: number; claudeStatus?: 'ok' | 'error'; resetsAt?: string } = {}): PlanUsageReport {
  return {
    providers: [
      {
        provider: 'claude',
        status: opts.claudeStatus ?? 'ok',
        windows: [
          { id: 'session', label: '5-hour session', usedPercent: claude, resetsAt: opts.resetsAt ?? new Date(T0 + HOUR).toISOString() },
          { id: 'week', label: 'Week, all models', usedPercent: 20 },
          { id: 'week-opus', label: 'Week, Opus', usedPercent: opts.weekOpus ?? 0 },
        ],
        notes: [],
        source: 'test',
        asOf: new Date(T0).toISOString(),
      },
      { provider: 'codex', status: 'ok', windows: [{ id: 'secondary', label: 'Week', usedPercent: codex }], notes: [], source: 'test', asOf: new Date(T0).toISOString() },
    ],
  };
}

async function guardWith(r: PlanUsageReport, percent: number | undefined, now = () => T0) {
  const g = new PlanGuard(async () => r, () => {}, now);
  g.setPercent(percent);
  await g.ready();
  return g;
}

test('holds Claude / Codex at or above the threshold; never Pi or an unknown harness', async () => {
  const g = await guardWith(report(96, 95), 95);
  assert.match(g.holds('claude')?.reason ?? '', /Claude plan 5-hour session at 96% \(plan guard 95%\)/);
  assert.equal(g.holds('codex')?.window, 'Week');
  assert.equal(g.holds('pi'), null);
  assert.equal(g.holds(undefined), null);
  assert.equal((await guardWith(report(94), 95)).holds('claude'), null, 'below the threshold');
});

test('off, model-only windows, unreadable plans and passed resets never hold', async () => {
  assert.equal((await guardWith(report(100), undefined)).holds('claude'), null, 'off by default');
  assert.equal((await guardWith(report(100), 0)).holds('claude'), null, '0 = off');
  assert.equal((await guardWith(report(10, 10, { weekOpus: 100 }), 90)).holds('claude'), null, 'week-opus binds one model only');
  assert.equal((await guardWith(report(100, 10, { claudeStatus: 'error' }), 90)).holds('claude'), null);
  const g = await guardWith(report(100, 10, { resetsAt: new Date(T0 - 60_000).toISOString() }), 90);
  assert.equal(g.holds('claude'), null, 'the window already reset');
  const failing = new PlanGuard(async () => { throw new Error('offline'); }, () => {}, () => T0);
  failing.setPercent(90);
  await failing.ready();
  assert.equal(failing.holds('claude'), null);
});

test('a stale read refreshes in the background and re-drains when it lands', async () => {
  let t = T0;
  let used = 99;
  let reads = 0;
  let changes = 0;
  const g = new PlanGuard(async () => { reads += 1; return report(used); }, () => { changes += 1; }, () => t);
  g.setPercent(90);
  await g.ready();
  assert.ok(g.holds('claude'));
  used = 5;
  t += REFRESH_MS - 1;
  assert.ok(g.holds('claude'), 'fresh enough: no re-read yet');
  t += 2;
  g.holds('claude');
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2);
  assert.equal(changes, 2);
  assert.equal(g.holds('claude'), null, 'the window was reset upstream');
});

test('the queue holds a Claude batch spawn but admits Pi and priority beside it, and starts it once released', async (t) => {
  const original = queueState.planGuard;
  // Real clock here: the reset must lie in the real future.
  queueState.planGuard = new PlanGuard(async () => report(97, 10, { resetsAt: new Date(Date.now() + HOUR).toISOString() }), () => {});
  t.after(() => {
    queueState.planGuard = original;
  });
  setSpawnQueuePlanGuard(90);
  await queueState.planGuard.ready();

  const started: string[] = [];
  const spawn = (key: string, harness: string, priority: 'batch' | 'priority' = 'batch') =>
    enqueueSpawn({ kind: 'task-run', priority, dedupeKey: `plan-guard:${key}`, harness, thunk: async () => { started.push(key); } }).done;

  // The queue's own poll targets the preload's closed executor port, and a
  // failed poll freezes admission — so mark it healthy and enqueue (each
  // enqueue drains synchronously) before any poll can land, here and at the
  // release below. A frozen queue would hang, not fail: race a timer.
  queueState.accounting.reconcile(0, Date.now());
  const claude = spawn('claude', 'claude');
  const pi = spawn('pi', 'pi');
  const resolver = spawn('resolver', 'claude', 'priority');
  const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('not admitted')), 5000).unref())]);
  await within(Promise.all([pi, resolver]));
  assert.deepEqual(started, ['pi', 'resolver']);
  const held = getSpawnQueueSnapshot().items.find((i) => i.dedupeKey === 'plan-guard:claude');
  assert.equal(held?.state, 'pending', 'held, not dropped');
  assert.match(held?.heldByPlan ?? '', /Claude plan/);
  assert.deepEqual(getSpawnQueueSnapshot().planGuard, { percent: 90, held: 1 });
  assert.match((await batchAdmissionHold('claude')) ?? '', /plan guard 90%/, 'the workflow Start step sees it too');

  queueState.accounting.reconcile(0, Date.now());
  setSpawnQueuePlanGuard(undefined);
  await within(claude);
  assert.deepEqual(started, ['pi', 'resolver', 'claude']);
});

test('PATCH /api/global-settings validates planGuardPercent and applies it to the live queue', async (t) => {
  const original = queueState.planGuard;
  queueState.planGuard = new PlanGuard(async () => report(0), () => {});
  t.after(() => {
    queueState.planGuard = original;
  });
  const app = express();
  app.use(express.json());
  app.use(buildGlobalSettingsRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/global-settings`;
  const patch = (body: unknown) => fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  for (const bad of ['90', 150, -1]) assert.equal((await patch({ planGuardPercent: bad })).status, 400, String(bad));
  assert.equal((await patch({ planGuardPercent: 90 })).status, 200);
  assert.equal(getSpawnQueueSnapshot().planGuard.percent, 90);
  assert.equal(((await (await fetch(url)).json()) as { planGuardPercent?: number }).planGuardPercent, 90, 'persisted');
  assert.equal((await patch({ planGuardPercent: 0 })).status, 200);
  assert.equal(getSpawnQueueSnapshot().planGuard.percent, null, '0 turns it off');
});
