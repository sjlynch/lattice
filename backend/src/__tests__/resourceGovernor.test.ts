import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CPU_BLOCK_PCT,
  MIN_LIVE_AGENTS,
  ResourceGovernor,
  type GovernorSampler,
} from '../spawnQueue/resourceGovernor.js';
import { withCheckoutSlot } from '../worktree/checkoutGate.js';
import { watchParentProcess } from '../terminalServer/parentWatch.js';

// Regression coverage for the 2026-09-22 CPU-saturation freeze: a fixed
// 50-agent cap on a large repo pinned the CPU at 100% until the desktop hung.

const GB = 1024 ** 3;

// A fake clock + CPU counter: each `tick(pct)` advances 1.5 s (one queue poll)
// at the given utilization.
function fakeSampler(freeMem = 16 * GB) {
  let t = 0;
  let idle = 0;
  let total = 0;
  const s: GovernorSampler & { tick: (pct: number) => void; free: number } = {
    free: freeMem,
    cpuTimes: () => ({ idle, total }),
    freeMem: () => s.free,
    totalMem: () => 32 * GB,
    now: () => t,
    tick: (pct) => {
      t += 1500;
      total += 1500;
      idle += 1500 * (1 - pct / 100);
    },
  };
  return s;
}

function runAt(g: ResourceGovernor, s: ReturnType<typeof fakeSampler>, pct: number, polls: number) {
  for (let i = 0; i < polls; i += 1) {
    s.tick(pct);
    g.sample();
  }
}

test('governor holds batch spawns under sustained CPU saturation and releases with hysteresis', () => {
  const s = fakeSampler();
  const g = new ResourceGovernor(s);
  g.sample();
  runAt(g, s, 30, 10);
  assert.equal(g.holdsBatch(10), false, 'normal load admits');
  runAt(g, s, 100, 60); // 90 s pegged
  assert.equal(g.holdsBatch(10), true, 'sustained 100% holds');
  assert.ok((g.state().cpuPct ?? 0) >= CPU_BLOCK_PCT);
  runAt(g, s, 82, 60); // between resume (75) and block (90): stays held
  assert.equal(g.holdsBatch(10), true, 'hysteresis: still held above the resume threshold');
  runAt(g, s, 20, 60);
  assert.equal(g.holdsBatch(10), false, 'released once load drops');
});

test('a brief CPU spike does not hold admissions', () => {
  const s = fakeSampler();
  const g = new ResourceGovernor(s);
  g.sample();
  runAt(g, s, 30, 20);
  runAt(g, s, 100, 2); // 3 s spike
  assert.equal(g.holdsBatch(10), false);
});

test('the floor: with fewer than MIN_LIVE_AGENTS sessions nothing is held', () => {
  const s = fakeSampler();
  const g = new ResourceGovernor(s);
  g.sample();
  runAt(g, s, 100, 60);
  assert.equal(g.holdsBatch(MIN_LIVE_AGENTS - 1), false, 'outside load cannot starve Lattice to zero');
  assert.equal(g.holdsBatch(MIN_LIVE_AGENTS), true);
});

test('low free RAM holds batch spawns; disabling the governor lifts every hold', () => {
  const s = fakeSampler(1 * GB);
  const g = new ResourceGovernor(s);
  g.sample();
  runAt(g, s, 10, 5);
  assert.equal(g.holdsBatch(5), true);
  assert.match(g.state().reason ?? '', /RAM/);
  g.setEnabled(false);
  assert.equal(g.holdsBatch(5), false);
});

test('checkout gate runs at most two checkouts at once, in FIFO order', async () => {
  let running = 0;
  let peak = 0;
  const order: number[] = [];
  const job = (i: number) => withCheckoutSlot(async () => {
    running += 1;
    peak = Math.max(peak, running);
    order.push(i);
    await new Promise((r) => setTimeout(r, 5));
    running -= 1;
    return i;
  });
  const results = await Promise.all([1, 2, 3, 4, 5].map(job));
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.equal(peak, 2);
  assert.deepEqual(order, [1, 2, 3, 4, 5]);
  // A throwing checkout still frees its slot.
  await assert.rejects(withCheckoutSlot(async () => { throw new Error('boom'); }));
  assert.equal(await withCheckoutSlot(async () => 'ok'), 'ok');
});

test('parent watch keeps polling while the caller declines to shut down (live agents)', async () => {
  let calls = 0;
  let allow = false;
  await new Promise<void>((resolve) => {
    watchParentProcess(
      12345,
      () => {
        calls += 1;
        if (calls === 3) allow = true; // sessions ended
        if (allow) {
          resolve();
          return true;
        }
        return false;
      },
      5,
      () => false, // parent is gone
    );
  });
  assert.ok(calls >= 3, 'did not shut down on the first parent-gone tick');
});

// An interrupted `git worktree add` leaves git's own "initializing" lock,
// which every teardown path honoured as a user lock — stranding the
// half-written (multi-GB) checkout forever.
test('stale "initializing" locks are cleared; user locks and fresh adds are not', async () => {
  const { parseWorktreesPorcelain } = await import('../worktree/state.js');
  const { clearStaleInitializingLock } = await import('../worktree/staleInitLock.js');
  const { homeWorktreesDir } = await import('../projectPath.js');
  const path = await import('node:path');
  const repo = 'C:\repo-stale-lock';
  const wtPath = path.join(homeWorktreesDir(repo), 'task-abc');
  const [wt] = parseWorktreesPorcelain(`worktree ${wtPath}\0HEAD 1\0branch refs/heads/lattice/task-abc\0locked initializing\0\0`);
  assert.equal(wt.locked, true);
  assert.equal(wt.lockReason, 'initializing');

  const unlocked: string[] = [];
  const deps = (ageMs: number) => ({
    lockFileMtimeMs: async () => 1_000_000 - ageMs,
    unlock: async (_r: string, p: string) => {
      unlocked.push(p);
      return true;
    },
    now: () => 1_000_000,
  });
  assert.equal(await clearStaleInitializingLock(repo, wt, deps(60_000)), false, 'an add still in progress keeps its lock');
  assert.equal(await clearStaleInitializingLock(repo, { ...wt, lockReason: 'user: keep this' }, deps(3_600_000)), false);
  assert.equal(await clearStaleInitializingLock(repo, { ...wt, path: 'C:\elsewhere\wt' }, deps(3_600_000)), false,
    'never outside a Lattice-managed worktrees dir');
  assert.deepEqual(unlocked, []);
  assert.equal(await clearStaleInitializingLock(repo, wt, deps(3_600_000)), true);
  assert.deepEqual(unlocked, [wtPath]);
});
