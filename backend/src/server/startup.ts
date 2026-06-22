import type http from 'node:http';
import { detectHarnesses } from '../harnessDetect.js';
import { ensurePiSubagentsInstalled } from '../piSubagents.js';
import { reconcilePiModelsJson } from '../piModels.js';
import {
  recoverOrphanedTasks,
  resumeInterruptedMergeRuns,
  resumeQueuedTaskRuns,
  startInProgressSweepLoop,
} from '../recovery.js';
import { startSpawnQueue } from '../spawnQueue.js';
import { ensureTerminalServer } from '../terminalProxy.js';
import { createBackendApp } from './app.js';
import {
  getBackendServerConfig,
  type BackendServerConfig,
} from './config.js';
import { createHttpServerWithWebSockets } from './http.js';

export async function startBackend(
  config: BackendServerConfig = getBackendServerConfig(),
): Promise<http.Server> {
  const server = createBackendHttpServer(config);
  startHarnessDetection();
  await runPreListenStartupRecovery();
  await listenForRequests(server, config);
  resumeRunsAfterListen(config.backendOrigin);
  return server;
}

export function createBackendHttpServer(
  config: BackendServerConfig,
): http.Server {
  const app = createBackendApp({
    defaultRoot: config.defaultRoot,
    backendOrigin: config.backendOrigin,
  });
  return createHttpServerWithWebSockets(app);
}

export function startHarnessDetection(): void {
  // Kick off harness CLI detection now so its result is ready when the
  // frontend's /ws/harnesses connection lands. Probe failures are
  // swallowed inside the module's cache.
  detectHarnesses().catch(() => {});
  // If `pi` is installed, auto-install the pi-subagents extension into a shared
  // Lattice-owned dir (project-local, never the user's global pi config) so the
  // loader shim has a target to point at. Fire-and-forget — runs concurrently
  // with listen; never throws. See piSubagents.ts.
  ensurePiSubagentsInstalled().catch(() => {});
  // Reconcile any Lattice-managed Pi providers into ~/.pi/agent/models.json so
  // the endpoints configured in Settings → Pi survive an out-of-band edit and
  // are present before the first spawn. Fire-and-forget; never throws.
  reconcilePiModelsJson().catch(() => {});
}

export async function runPreListenStartupRecovery(): Promise<void> {
  await ensureTerminalServer();
  // Prime the spawn queue's session accounting (one /sessions poll) before
  // any recovery phase enqueues work, so the first spawn admits immediately.
  await startSpawnQueue().catch((err) =>
    console.error('[startup] startSpawnQueue failed:', err),
  );
  await recoverOrphanedTasks();
}

export function listenForRequests(
  server: http.Server,
  config: Pick<BackendServerConfig, 'port' | 'defaultRoot'>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      console.log(`[lattice-backend] listening on http://127.0.0.1:${config.port}`);
      console.log(`[lattice-backend] default root: ${config.defaultRoot}`);
      resolve();
    };
    server.once('error', onError);
    // Bind loopback-only (NOT 'localhost' — on Windows that can resolve to
    // ::1 and miss IPv4 callers). The frontend reaches the backend through
    // vite's dev-server proxy (127.0.0.1) and every hook callback uses
    // backendOrigin=http://127.0.0.1, so this closes the LAN-reachable
    // raw-backend hole without affecting any working path. Single-machine
    // personal tool — no remote-access opt-in needed. Mirrors
    // terminal-server.ts, which already binds 127.0.0.1.
    server.listen(config.port, '127.0.0.1', onListening);
  });
}

export function resumeRunsAfterListen(backendOrigin: string): void {
  // Now that the API is up, resume any merge run a previous process was
  // running when it got restarted (resolver Claudes it may spawn need
  // the API listening to call back).
  resumeInterruptedMergeRuns(backendOrigin).catch((err) =>
    console.error('[startup] resumeInterruptedMergeRuns failed:', err),
  );
  // Re-enqueue task runs that were waiting in the spawn queue when the
  // backend stopped (their `runQueued` flag is persisted on the task).
  // Runs post-listen and after the pre-listen orphan-worktree sweep so a
  // half-created worktree is reconciled rather than reclaimed.
  resumeQueuedTaskRuns(backendOrigin).catch((err) =>
    console.error('[startup] resumeQueuedTaskRuns failed:', err),
  );
  // Periodic staleness sweep for `in_progress` tasks whose PTY has died
  // and whose branch has commits (the Pi extension / model curl failed
  // for some reason). Complements the boot-time `recoverOrphanedTasks`,
  // which only catches `ready_to_merge` tasks with deleted branches.
  // See recovery/inProgressSweep.ts for the criteria.
  startInProgressSweepLoop();
}
