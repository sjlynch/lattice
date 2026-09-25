import type http from 'node:http';
import { detectHarnesses } from '../harnessDetect.js';
import { ensurePiSubagentsInstalled } from '../piSubagents.js';
import { ensurePiMcpInstalled } from '../piMcp.js';
import { reconcilePiModelsJson, refreshEndpointDiscovery } from '../piModels.js';
import {
  recoverOrphanedTasks,
  resumeInterruptedMergeRuns,
  resumeInterruptedWorkflowRuns,
  resumeQueuedTaskRuns,
  startBootWorktreeSweep,
  startInProgressSweepLoop,
  startWorktreeResidueSweepLoop,
} from '../recovery.js';
import { startSpawnQueue } from '../spawnQueue.js';
import { startLowDiskMonitor } from '../diskPressureMerge.js';
import { ensureTerminalServer } from '../terminalProxy.js';
import { createBackendApp } from './app.js';
import {
  getBackendServerConfig,
  type BackendServerConfig,
} from './config.js';
import { createHttpServerWithWebSockets } from './http.js';
import { beginWorkflowRecovery } from '../workflowRuns/recoveryReadiness.js';
import { startTerminalRegistryWatch } from '../terminalRegistry/watch.js';
import { ensureCallbackScript, startCallbackOutboxLoop } from '../callbackOutbox.js';
import { fireOwedPostMergeHooks } from '../recovery/owedPostMergeHooks.js';

export async function startBackend(
  config: BackendServerConfig = getBackendServerConfig(),
): Promise<http.Server> {
  const server = createBackendHttpServer(config);
  startHarnessDetection();
  await runPreListenStartupRecovery();
  const finishWorkflowRecovery = beginWorkflowRecovery();
  try {
    await listenForRequests(server, config);
    resumeRunsAfterListen(config.backendOrigin, finishWorkflowRecovery);
  } catch (err) {
    finishWorkflowRecovery();
    throw err;
  }
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
  // Likewise pre-install pi-mcp-adapter (the Pi MCP loader) into its own
  // shared Lattice-owned dir so the first Pi spawn that enables an MCP server
  // has a shim target. Fire-and-forget; never throws. See piMcp.ts.
  ensurePiMcpInstalled().catch(() => {});
  // Reconcile any Lattice-managed Pi providers into ~/.pi/agent/models.json so
  // the endpoints configured in Settings → Pi survive an out-of-band edit and
  // are present before the first spawn. Fire-and-forget; never throws.
  // Reconcile the managed providers into models.json, then ask each
  // auto-discover endpoint what it is serving right now — so a server that was
  // restarted on a different model while Lattice was down is already correct by
  // the time the first harness dropdown opens.
  reconcilePiModelsJson()
    .then(() => refreshEndpointDiscovery({ force: true }))
    .catch(() => {});
}

export async function runPreListenStartupRecovery(): Promise<void> {
  await ensureTerminalServer().catch((err) =>
    console.error('[startup] terminal server unavailable; continuing with conservative session probes:', err),
  );
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

export type BootRecoveryChainDeps = {
  resumeWorkflowRuns: typeof resumeInterruptedWorkflowRuns;
  resumeMergeRuns: typeof resumeInterruptedMergeRuns;
  fireOwedHooks: typeof fireOwedPostMergeHooks;
  startOutbox: typeof startCallbackOutboxLoop;
};

const bootRecoveryChainDeps: BootRecoveryChainDeps = {
  resumeWorkflowRuns: resumeInterruptedWorkflowRuns,
  resumeMergeRuns: resumeInterruptedMergeRuns,
  fireOwedHooks: fireOwedPostMergeHooks,
  startOutbox: startCallbackOutboxLoop,
};

// Exported for tests (the deps seam); production reaches it through
// resumeRunsAfterListen.
export function runBootRecoveryChain(
  backendOrigin: string,
  finishWorkflowRecovery = () => {},
  deps: BootRecoveryChainDeps = bootRecoveryChainDeps,
): Promise<void> {
  // Workflow runs first, and awaited before the merge-run resume: a workflow
  // parked on a long AGENT step holds no run.lock, so nothing defers a restart
  // during it and the run would otherwise be lost outright (its still-running
  // agent then POSTs /complete into a backend that has never heard of the run).
  // Ordering matters — a resumed workflow owns its project's merge pipeline via
  // its own Merge control step, and resumeInterruptedMergeRuns skips a project
  // that has an active workflow run rather than racing it.
  // The workflow resume settles once every run is re-registered and its
  // dispatch decision is applied; a re-dispatched agent step's pre-run (an
  // Opengrep scan, minutes) carries on detached rather than holding up the
  // merge resume, owed hooks and outbox replay below.
  return deps.resumeWorkflowRuns(backendOrigin, finishWorkflowRecovery)
    .catch((err) => console.error('[startup] resumeInterruptedWorkflowRuns failed:', err))
    .finally(finishWorkflowRecovery)
    .then(() =>
      // Now that the API is up, resume any merge run a previous process was
      // running when it got restarted (resolver Claudes it may spawn need
      // the API listening to call back).
      deps.resumeMergeRuns(backendOrigin).catch((err) =>
        console.error('[startup] resumeInterruptedMergeRuns failed:', err),
      ),
    )
    .then(() =>
      // Last: a post-merge hook a pre-restart merge still owes, for a project
      // that neither resume above took over (their own paths fire it).
      deps.fireOwedHooks(backendOrigin).catch((err) =>
        console.error('[startup] fireOwedPostMergeHooks failed:', err),
      ),
    )
    // Replay undelivered completion callbacks only once the runs above are
    // re-adopted / re-dispatched: a replayed push `/done` that beat the Push
    // step's re-dispatch used to make it push a second time.
    .finally(() => deps.startOutbox(backendOrigin));
}

export function resumeRunsAfterListen(backendOrigin: string, finishWorkflowRecovery = () => {}): void {
  void runBootRecoveryChain(backendOrigin, finishWorkflowRecovery);
  // Re-enqueue task runs that were waiting in the spawn queue when the
  // backend stopped (their `runQueued` flag is persisted on the task).
  // Runs post-listen and after the pre-listen orphan-worktree sweep so a
  // half-created worktree is reconciled rather than reclaimed.
  // Runs after the orphan-worktree sweep (now post-listen, recovery/index.ts
  // startBootWorktreeSweep) so a half-created worktree is reconciled rather
  // than reclaimed.
  void startBootWorktreeSweep().then(() =>
    resumeQueuedTaskRuns(backendOrigin).catch((err) =>
      console.error('[startup] resumeQueuedTaskRuns failed:', err),
    ),
  );
  // Periodic staleness sweep for `in_progress` tasks whose PTY has died
  // and whose branch has commits (the Pi extension / model curl failed
  // for some reason). Complements the boot-time `recoverOrphanedTasks`,
  // which only catches `ready_to_merge` tasks with deleted branches.
  // See recovery/inProgressSweep.ts for the criteria.
  startInProgressSweepLoop();
  // Every 30 min, reclaim residue a failed `git worktree remove` left under
  // ~/.lattice/worktrees/ while the backend was up (the boot pass only sees
  // what an earlier process left). See recovery/worktreeResidueSweep.ts.
  startWorktreeResidueSweepLoop();
  // Once a minute: if a project's worktree volume dips under the free-space
  // reserve, merge its Ready-to-Merge tasks (their worktrees are what fills
  // it). See diskPressureMerge.ts.
  startLowDiskMonitor(backendOrigin);
  // Keep the durable terminal-tab registry honest against the live executor
  // (exited ptys are ended so restore never relaunches them; busy transitions
  // are stamped for the interruption detector). See terminalRegistry/watch.ts.
  startTerminalRegistryWatch();
  // Rewrite the Stop hooks' delivery script so every hook installed from here
  // on runs the current one. The outbox replay itself starts at the end of the
  // recovery chain above. See callbackOutbox/.
  ensureCallbackScript();
}
