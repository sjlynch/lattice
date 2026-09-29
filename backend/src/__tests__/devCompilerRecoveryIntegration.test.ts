import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withTempDir } from './helpers/tempDir.js';
import { createBackendLifecycle } from '../../scripts/dev/backendLifecycle.mjs';
import { createCompilerLifecycle } from '../../scripts/dev/compilerLifecycle.mjs';
import { createRestartPolicy } from '../../scripts/dev/restartPolicy.mjs';
import { startTscWatch, type TscWatchChild } from '../../scripts/dev/tscWatch.mjs';

async function eventually(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await delay(20);
  }
}

test('a real compiler exit -1 preserves the backend and recovers through workflow and compile gates', { timeout: 60_000 }, async () => {
  await withTempDir('lattice-compiler-recovery-', async (dir) => {
    const fixture = path.join(dir, 'compiler.mjs');
    const control = path.join(dir, 'control');
    await fs.writeFile(control, 'complete');
    // A protocol fixture exercises actual child exit/pipe delivery, without
    // running a Lattice server or writing into this checkout's dist directory.
    await fs.writeFile(fixture, `
      import fs from 'node:fs';
      import { fileURLToPath } from 'node:url';
      const control = fileURLToPath(new URL('./control', import.meta.url));
      console.log('Starting compilation in watch mode...');
      if (!process.argv.includes('--watchFile')) {
        process.stdout.write('Found 0 errors. Watching for file changes.\\n', () => process.exit(-1));
      } else {
        // Capture the baseline before readiness lets the parent send 'begin'.
        // Otherwise a delayed read can swallow that command as the baseline.
        let previous = fs.readFileSync(control, 'utf8');
        console.log('Found 0 errors. Watching for file changes.');
        setInterval(() => {
          const command = fs.readFileSync(control, 'utf8');
          if (command === previous) return;
          previous = command;
          if (command === 'begin') console.log('File change detected. Starting incremental compilation...');
          if (command === 'complete') console.log('Found 0 errors. Watching for file changes.');
          if (command === 'crash') process.exit(-1);
        }, 20);
      }
    `);

    let shuttingDown = false;
    let workflowLock = true;
    let signature = 'running-code';
    let mtime = 1;
    let retry: (() => void) | undefined;
    let shutdownCalls = 0;
    const backendChildren: (EventEmitter & { pid: number; kills: number; kill(): boolean })[] = [];
    const compilerChildren: TscWatchChild[] = [];
    const compilerCloses: Promise<unknown>[] = [];
    const compilerExits: number[] = [];
    let compiler: ReturnType<typeof createCompilerLifecycle> | undefined;
    let policy!: ReturnType<typeof createRestartPolicy>;
    const backend = createBackendLifecycle({
      copyAssetsBeforeRespawn() {},
      isShuttingDown: () => shuttingDown,
      onExitDuringShutdown() { shutdownCalls++; },
      canSpawnBackend: () => !compiler || compiler.canRestartBackend(),
      captureBackendVersion: () => policy.captureDistBaseline(),
      onBackendSpawned: (candidate) => policy.onBackendSpawned(candidate),
      probePort: async () => false, // never probe the real port from a unit test
      spawnProcess: (() => {
        const child = Object.assign(new EventEmitter(), {
          pid: 987000 + backendChildren.length,
          kills: 0,
          kill() { this.kills++; return true; },
        });
        backendChildren.push(child);
        return child;
      }) as unknown as typeof spawn,
    });
    policy = createRestartPolicy({
      restartBackend: backend.restartBackend,
      canRestart: () => Boolean(compiler?.canRestartBackend()),
      needsBackendStart: backend.needsStart,
      deferBaselineUntilSpawn: true,
      operationInFlight: () => workflowLock,
      workflowInFlight: () => workflowLock,
      readNewestDistMtime: () => mtime,
      readDistContentSignature: () => signature,
      // Compiler recovery is under test here, not the post-lock settle (which
      // has its own tests); without this the lock release adds a 5 s wait.
      lockSettleMs: 0,
    });
    policy.resetDistBaseline();
    backend.start();
    backendChildren[0].emit('spawn');
    compiler = createCompilerLifecycle({
      tscBin: fixture,
      onCompileSucceeded: policy.onCompileSucceeded,
      startWatch: (bin, options) => {
        const child = startTscWatch(bin, { ...options, forwardOutput() {}, recordLine() {} });
        compilerChildren.push(child);
        compilerCloses.push(once(child, 'close'));
        return child;
      },
      retryDelays: [1, 1],
      schedule: (callback) => { retry = callback; return {} as ReturnType<typeof setTimeout>; },
      unschedule: () => { retry = undefined; },
      record: (_label, code) => { compilerExits.push(code); },
    });
    try {
      compiler.start();
      await eventually(() => Boolean(retry) && compilerExits.length > 0, 'compiler exit must schedule and record a repair');
      assert.equal(compilerExits[0], process.platform === 'win32' ? 4294967295 : 255);
      assert.equal(backendChildren.length, 1);
      assert.equal(backendChildren[0].kills, 0);
      assert.equal(shutdownCalls, 0);
      assert.equal(compiler.canRestartBackend(), false);

      signature = 'edited-during-compiler-downtime';
      mtime = 2;
      policy.onDistChanged();
      assert.equal(backendChildren[0].kills, 0, 'partial output cannot restart the backend');
      const repair = retry!;
      retry = undefined;
      repair();
      await eventually(() => compiler!.canRestartBackend(), 'repair must compile successfully');
      assert.equal(backendChildren[0].kills, 0, 'workflow lock must survive compiler recovery');

      workflowLock = false;
      policy.onDistChanged();
      assert.equal(backendChildren[0].kills, 1, 'completed changed output can request a restart');
      await fs.writeFile(control, 'begin');
      await eventually(() => !compiler!.canRestartBackend(), 'next compile must close the spawn gate');
      backendChildren[0].emit('exit', 0, null);
      assert.equal(backendChildren.length, 1, 'pending backend exit cannot spawn against partial output');
      await fs.writeFile(control, 'complete');
      await eventually(() => backendChildren.length === 2, 'successful compile must restart the missing backend');
      backendChildren[1].emit('spawn');
      assert.equal(shutdownCalls, 0);

      await fs.writeFile(control, 'crash');
      await eventually(() => Boolean(retry), 'a later compiler crash must also be contained');
      assert.equal(backendChildren[1].kills, 0);
      const secondRepair = retry!;
      retry = undefined;
      await fs.writeFile(control, 'complete');
      secondRepair();
      await eventually(() => compiler!.canRestartBackend(), 'second repair must settle');
      assert.equal(backendChildren.length, 2);
      assert.equal(backendChildren[1].kills, 0, 'identical output after repair must retain the backend');
      assert.equal(shutdownCalls, 0);
    } finally {
      shuttingDown = true;
      policy.stopDeferredPoll();
      compiler.stop();
      for (const child of compilerChildren) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
      await Promise.all(compilerCloses);
    }
  });
});
