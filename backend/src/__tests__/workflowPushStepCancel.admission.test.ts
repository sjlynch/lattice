// A workflow Push step cancelled or timed out before its PTY exists, driven
// through the real spawn admission queue with controlled terminal creation and
// home-scoped scratch. The post-spawn guard cannot settle a Push still waiting
// for capacity: an aborted admission signal must reach the scratch agent
// adapters (setup cleaned, nothing spawned); a capacity-blocked Push must
// withdraw its admission, clean scratch and release its lock without any
// capacity grant; one cancelled during PTY creation keeps its lock until the
// late PTY is reclaimed (an unconfirmed kill retains ownership).
// Shared fixtures: helpers/workflowPushStepCancel.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPushStep, type PushStepDeps } from '../workflowRuns/controlSteps/push.js';
import { runControlStepWorker } from '../workflowRuns/controlStep.js';
import { subscribe, type WorkflowRunEvent } from '../workflowRuns/state.js';
import type { Workflow } from '../workflows.js';
import { createHomeScratchPaths } from '../homeScratch/paths.js';
import { createHomeScratchAgentSession } from '../homeScratch/agentSession.js';
import { queuedCreateSession } from '../queuedCreateSession.js';
import { cancelSpawn } from '../spawnQueue.js';
import { queueState } from '../spawnQueue/state.js';
import { SPAWN_QUEUE_CONFIG } from '../spawnQueue/config.js';
import { drainQueue } from '../spawnQueue/drain.js';
import { withTempDir } from './helpers/tempDir.js';
import { makeRun, waitFor } from './helpers/workflowPushStepCancel.js';

// The post-spawn guard cannot settle a Push still waiting for capacity. Use
// the real admission queue with controlled terminal creation and scratch so
// cancellation/timeout must remove the request without any capacity grant.
function resetCapacity(): void {
  queueState.accounting.setSoftCap(SPAWN_QUEUE_CONFIG.softCap);
  queueState.accounting.reconcile(0, Date.now() + 1);
}

async function awaitWorker<T>(worker: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  try {
    return await Promise.race([
      worker,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Push worker did not settle')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function queuedPushFixture(
  projectPath: string,
  pushTimeoutMs: number,
  terminals: Parameters<typeof queuedCreateSession>[1],
) {
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  const paths = createHomeScratchPaths({
    dirName: 'push-admission-test', idPrefix: 'push', logLabel: '[push-test]', noun: 'push session',
  });
  const id = paths.createSessionId();
  const cwd = paths.assertSafeSessionPath(projectPath, id);
  await fs.mkdir(cwd, { recursive: true });
  const dedupeKey = `push:${id}`;
  const cleaned: string[] = [];
  const holder = { cancel: undefined as ((ev: WorkflowRunEvent) => void) | undefined };
  const deps: PushStepDeps = {
    pushTimeoutMs,
    waitForLaneEmpty: async () => undefined,
    subscribePushRuns: () => () => undefined,
    subscribeWorkflowRuns: (cb) => {
      holder.cancel = cb;
      return () => { holder.cancel = undefined; };
    },
    startPushSession: async (_project, _origin, opts) => {
      try {
        const session = await queuedCreateSession({
          kind: 'push-run', priority: 'interactive', dedupeKey, opts: { cwd }, signal: opts?.signal,
        }, terminals);
        if ('error' in session) throw new Error(session.error);
        return { id, cwd, serverId: session.id, command: 'claude' };
      } catch (err) {
        await fs.rm(paths.assertSafeSessionPath(projectPath, id), { recursive: true, force: true });
        cleaned.push(id);
        throw err;
      }
    },
    getPushRun: () => undefined,
    proxyKillSession: async () => assert.fail('the queue must reclaim an undelivered PTY'),
    abandonPushRun: () => assert.fail('an unstarted push has no run to abandon'),
  };
  return { id, cwd, dedupeKey, cleaned, holder, deps };
}

test('the scratch agent adapters forward an aborted admission signal and clean setup without spawning', async () => {
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  await withTempDir('lattice-push-signal-', async (projectPath) => {
    const paths = createHomeScratchPaths({
      dirName: 'push-signal-test', idPrefix: 'push', logLabel: '[push-test]', noun: 'push session',
    });
    const id = paths.createSessionId();
    const cwd = paths.assertSafeSessionPath(projectPath, id);
    const cleaned: string[] = [];
    const start = createHomeScratchAgentSession({
      paths: { ...paths, createSessionId: () => id },
      instructionsFileName: 'BRIEF.md',
      command: 'unused',
      queueKind: 'push-run',
      dedupeKeyPrefix: 'push',
      agentId: (sessionId) => `push:${sessionId}`,
      presenceLabel: 'push',
      cleanup: async (project, sessionId) => {
        await fs.rm(paths.assertSafeSessionPath(project, sessionId), { recursive: true, force: true });
        cleaned.push(sessionId);
      },
    });
    // With capacity blocked, a dropped signal would leave startup pending.
    queueState.accounting.setSoftCap(1);
    queueState.accounting.reconcile(1 + SPAWN_QUEUE_CONFIG.priorityReserve, Date.now() + 1);
    const controller = new AbortController();
    const cancelled = new Error('push cancelled before admission');
    controller.abort(cancelled);
    const started = start({
      projectPath,
      signal: controller.signal,
      installHooks: async () => undefined,
      renderInstructions: () => 'unused',
      recordRun: () => assert.fail('an aborted admission must not record a live run'),
    });
    try {
      await assert.rejects(awaitWorker(started), (err: unknown) => err === cancelled);
      assert.equal(queueState.get(`push:${id}`), undefined);
      assert.deepEqual(cleaned, [id]);
      await assert.rejects(fs.access(cwd), { code: 'ENOENT' });
    } finally {
      cancelSpawn(`push:${id}`);
      await started.catch(() => undefined);
      resetCapacity();
    }
  });
});

for (const reason of ['cancel', 'timeout'] as const) {
  test(`a capacity-blocked Push ${reason} withdraws admission, cleans scratch and releases its lock without capacity`, async () => {
    await withTempDir('lattice-push-admission-', async (projectPath) => {
      let created = 0;
      const fixture = await queuedPushFixture(projectPath, reason === 'timeout' ? 20 : 60_000, {
        proxyCreateSession: async () => { created += 1; return { id: 'must-not-spawn' }; },
        proxyKillSession: async () => assert.fail('a queued request has no PTY'),
      });
      queueState.accounting.setSoftCap(1);
      queueState.accounting.reconcile(1 + SPAWN_QUEUE_CONFIG.priorityReserve, Date.now() + 1);
      const run = { ...makeRun(), projectPath };
      const wf = { projectPath, steps: [{ kind: 'push' }] } as Workflow;
      let released = 0;
      let advanced = 0;
      const progress: string[] = [];
      let stepSpawned = false;
      const unsub = subscribe((ev) => {
        if (ev.type === 'step-control-progress' && ev.message) progress.push(ev.message);
        if (ev.type === 'step-spawned') stepSpawned = true;
      });
      const worker = runControlStepWorker(wf, run, 0, 'http://localhost', async () => { advanced += 1; }, {
        acquireLock: async () => ({ release: async () => {
          assert.deepEqual(fixture.cleaned, [fixture.id], 'scratch cleanup precedes lock release');
          released += 1;
        } }),
        waitForRepoMaintenance: async () => true,
        runStart: async () => undefined,
        runMerge: async () => undefined,
        runPush: (w, r, i, origin) => runPushStep(w, r, i, origin, fixture.deps),
      });
      try {
        await waitFor(() => !!queueState.get(fixture.dedupeKey));
        assert.equal(queueState.get(fixture.dedupeKey)?.state, 'pending');
        if (reason === 'cancel') {
          run.status = 'cancelled';
          fixture.holder.cancel!({ type: 'cancelled', run });
        }
        await awaitWorker(worker);
        assert.equal(queueState.get(fixture.dedupeKey), undefined, 'admission is withdrawn');
        assert.equal(queueState.accounting.getLiveCount(), 1 + SPAWN_QUEUE_CONFIG.priorityReserve);
        assert.equal(run.status, reason === 'cancel' ? 'cancelled' : 'errored');
        if (reason === 'timeout') assert.match(run.error ?? '', /push step timed out after 20ms/);
        else assert.equal(run.error, undefined);
        assert.equal(released, 1);
        assert.equal(advanced, 0);
        assert.equal(run.currentStepIndex, 0);
        assert.equal(stepSpawned, false);
        assert.ok(!progress.includes('push complete'));
        assert.deepEqual(fixture.cleaned, [fixture.id]);
        await assert.rejects(fs.access(fixture.cwd), { code: 'ENOENT' });
        resetCapacity();
        drainQueue();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(created, 0, 'capacity returning must not launch the cancelled admission');
      } finally {
        run.status = 'cancelled';
        cancelSpawn(fixture.dedupeKey);
        await worker;
        unsub();
        resetCapacity();
      }
    });
  });

  test(`a Push ${reason} during PTY creation retains its lock until the late PTY is reclaimed`, async () => {
    await withTempDir('lattice-push-in-flight-', async (projectPath) => {
      let resolveCreate!: (session: { id: string }) => void;
      let resolveKill!: (confirmed: boolean) => void;
      const creation = new Promise<{ id: string }>((resolve) => { resolveCreate = resolve; });
      const killing = new Promise<boolean>((resolve) => { resolveKill = resolve; });
      const killed: string[] = [];
      let creating = false;
      const fixture = await queuedPushFixture(projectPath, reason === 'timeout' ? 20 : 60_000, {
        proxyCreateSession: () => { creating = true; return creation; },
        proxyKillSession: (id) => { killed.push(id); return killing; },
      });
      resetCapacity();
      const run = { ...makeRun(), projectPath };
      const wf = { projectPath, steps: [{ kind: 'push' }] } as Workflow;
      let released = 0;
      let advanced = 0;
      const worker = runControlStepWorker(wf, run, 0, 'http://localhost', async () => { advanced += 1; }, {
        acquireLock: async () => ({ release: async () => { released += 1; } }),
        waitForRepoMaintenance: async () => true,
        runStart: async () => undefined,
        runMerge: async () => undefined,
        runPush: (w, r, i, origin) => runPushStep(w, r, i, origin, fixture.deps),
      });
      try {
        await waitFor(() => creating);
        if (reason === 'cancel') {
          run.status = 'cancelled';
          fixture.holder.cancel!({ type: 'cancelled', run });
        } else {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(queueState.get(fixture.dedupeKey)?.signal.aborted, true);
        assert.equal(released, 0, 'creation is still owned by the worker');
        assert.deepEqual(fixture.cleaned, []);
        resolveCreate({ id: 'late-push-pty' });
        await waitFor(() => killed.length > 0);
        assert.deepEqual(killed, ['late-push-pty']);
        assert.equal(released, 0, 'an unconfirmed kill must retain ownership');
        assert.deepEqual(fixture.cleaned, []);
        resolveKill(true);
        await awaitWorker(worker);
        assert.equal(released, 1);
        assert.equal(advanced, 0);
        assert.equal(run.status, reason === 'cancel' ? 'cancelled' : 'errored');
        if (reason === 'timeout') assert.match(run.error ?? '', /push step timed out after 20ms/);
        assert.equal(queueState.get(fixture.dedupeKey), undefined);
        assert.deepEqual(fixture.cleaned, [fixture.id]);
        await assert.rejects(fs.access(fixture.cwd), { code: 'ENOENT' });
      } finally {
        run.status = 'cancelled';
        cancelSpawn(fixture.dedupeKey);
        resolveCreate({ id: 'late-push-pty' });
        resolveKill(true);
        await worker;
        resetCapacity();
      }
    });
  });
}
