// Spawn-queue orchestration + agent-session registration for a workflow
// step's terminal. The step dir is already materialized by the coordinator
// (stepSpawner.ts); this module only routes the pty allocation through the
// spawn queue and, for a Claude step, registers the orange presence node.

import { proxyCreateSession, proxyKillSession } from '../terminalProxy.js';
import type { CreateSessionResult } from '../terminalServerClient.js';
import { cancelSpawn, enqueueSpawn, notifySessionsFreed, SpawnCapacityError } from '../spawnQueue.js';
import { registerAgentSession, unregisterAgentSession } from '../agentSessions.js';
import { forgetAgentQuiescence } from '../agentQuiescence.js';
import type { Workflow } from '../workflows.js';
import { checkpointWorkflowRun, notify, snapshot, type WorkflowRun } from './state.js';
import { isWorkflowStepActive, setStepPhase, stepPhase } from './execution.js';
import { markRunErrored } from './runErrored.js';

// Stable graph-node id for a workflow-step session. A new id per step, so
// advancing the run swaps one node for the next.
export function workflowStepAgentId(runId: string, stepIndex: number): string {
  return `wf:${runId}:${stepIndex}`;
}

function workflowStepDedupeKey(runId: string, stepIndex: number): string {
  return `wf-step:${runId}:${stepIndex}`;
}

type WorkflowStepSpawnRecord = {
  runId: string;
  stepIndex: number;
  dedupeKey: string;
  serverId?: string;
  spawning?: Promise<CreateSessionResult>;
  deps?: Pick<WorkflowStepSessionDeps, 'proxyKillSession'>;
};

const stepSpawnRecords = new Map<string, WorkflowStepSpawnRecord>();

function recordKey(runId: string, stepIndex: number): string {
  return `${runId}:${stepIndex}`;
}

function isCurrentRunningStep(run: WorkflowRun, stepIndex: number): boolean {
  return isWorkflowStepActive(run, stepIndex);
}

// Route the pty allocation through the spawn queue (fire-and-forget, like
// task runs): the step dir is materialized by the caller, only the pty waits
// for concurrency headroom. `step-spawned` fires from inside the thunk so it
// naturally lands when the queue admits the step, and the frontend
// (useWorkflowRuns) lazy-mounts the terminal off that event — exactly the
// pre-queue flow, just deferred.
export type WorkflowStepSessionDeps = {
  proxyCreateSession: typeof proxyCreateSession;
  proxyKillSession: typeof proxyKillSession;
};

const productionDeps: WorkflowStepSessionDeps = { proxyCreateSession, proxyKillSession };

// Drop everything a failed spawn left behind for the step.
function forgetFailedStepSpawn(run: WorkflowRun, stepIndex: number): void {
  unregisterAgentSession(workflowStepAgentId(run.id, stepIndex));
  forgetAgentQuiescence(workflowStepAgentId(run.id, stepIndex));
  stepSpawnRecords.delete(recordKey(run.id, stepIndex));
}

function markWorkflowStepSpawnErrored(
  run: WorkflowRun,
  stepIndex: number,
  error: string,
): void {
  forgetFailedStepSpawn(run, stepIndex);
  // A queued spawn may settle after cancellation or after a stale completion
  // callback advanced the run. In that case, do not overwrite the terminal
  // state; just make sure any speculative presence node is gone.
  if (!isCurrentRunningStep(run, stepIndex)) return;
  // Durable now — markRunErrored checkpoints; `notify` alone only schedules
  // the debounced mirror (see cancelWorkflowRun in ../workflowRuns.ts).
  if (run.stepStates?.[stepIndex]) run.stepStates[stepIndex].error = error;
  setStepPhase(run, stepIndex, 'errored');
  markRunErrored(run, `workflow step ${stepIndex + 1} failed to spawn: ${error}`);
}

async function killWorkflowStepServer(
  serverId: string,
  deps: Pick<WorkflowStepSessionDeps, 'proxyKillSession'>,
): Promise<void> {
  const killed = await deps.proxyKillSession(serverId);
  if (killed) notifySessionsFreed();
}

// Tear down a step's tracked pty on genuine advance (the completion callback in
// routes/workflows/runs.ts fires this the moment a step reports done). This
// deletes the spawn record AND kills the pty if one was allocated — the leak
// fix. An interactive Codex step (`codex --yolo` never self-exits after its
// turn) would otherwise sit alive forever after curling /complete, piling up
// zombie sessions and, because it stays live while the next step spawns, letting
// step N overlap step N+1. Killing here reclaims it and closes that window.
// Harness-agnostic and safe: a Claude/Pi session that already exited kills
// nothing (proxyKillSession no-ops on an unknown id), and one still idle-alive
// (e.g. an interactive Claude waiting after its Stop) is done with its work and
// safe to reclaim. Assumes the advance is genuine — the model curled /complete
// as its last action (its contract) or, for Claude, the quiescence gate already
// confirmed the session settled before advance() ran.
export async function killWorkflowStepSession(
  runId: string,
  stepIndex: number,
  deps?: Pick<WorkflowStepSessionDeps, 'proxyKillSession'>,
): Promise<void> {
  const key = recordKey(runId, stepIndex);
  const record = stepSpawnRecords.get(key);
  // The hook can beat the create-session HTTP response. Await that in-flight
  // allocation before declaring the old terminal gone and dispatching step N+1.
  if (record?.spawning) {
    const session = await record.spawning.catch(() => null);
    if (session && 'id' in session) record.serverId = session.id;
  }
  stepSpawnRecords.delete(key);
  if (!record?.serverId) return;
  try {
    await killWorkflowStepServer(record.serverId, deps ?? record.deps ?? productionDeps);
  } catch (err) {
    console.warn(
      `[workflow-run] ${runId} step ${stepIndex}: kill session ${record.serverId} on advance failed:`,
      err,
    );
  }
}

// The keep-open variant of killWorkflowStepSession (UserSettings
// .keepWorkflowStepTerminals): forget the step's spawn record — after its
// in-flight allocation settles — but leave the pty running, so its tab stays
// open for the user to read. Closing the tab kills it.
export async function releaseWorkflowStepSession(runId: string, stepIndex: number): Promise<void> {
  const key = recordKey(runId, stepIndex);
  const record = stepSpawnRecords.get(key);
  if (record?.spawning) await record.spawning.catch(() => null);
  stepSpawnRecords.delete(key);
}

// Re-attach a step's already-running pty to this process's bookkeeping after a
// backend restart (boot recovery discovers it by cwd — see
// recovery/workflowRunResume.ts). Without this the resumed run would advance
// without killing the finished step's session, re-opening the leak/overlap
// window `killWorkflowStepSession` exists to close.
export function adoptWorkflowStepSession(
  runId: string,
  stepIndex: number,
  serverId: string,
): void {
  stepSpawnRecords.set(recordKey(runId, stepIndex), {
    runId,
    stepIndex,
    dedupeKey: workflowStepDedupeKey(runId, stepIndex),
    serverId,
  });
}

export function cancelWorkflowStepSessions(
  runId: string,
  deps?: Pick<WorkflowStepSessionDeps, 'proxyKillSession'>,
): void {
  const records = [...stepSpawnRecords.values()].filter((record) => record.runId === runId);
  for (const record of records) {
    cancelSpawn(record.dedupeKey);
    unregisterAgentSession(workflowStepAgentId(record.runId, record.stepIndex));
    if (record.serverId) {
      void killWorkflowStepServer(record.serverId, deps ?? record.deps ?? productionDeps).catch((err) => {
        console.warn(
          `[workflow-run] ${record.runId} step ${record.stepIndex}: kill session ${record.serverId} failed:`,
          err,
        );
      });
    }
    stepSpawnRecords.delete(recordKey(record.runId, record.stepIndex));
  }
}

export function enqueueWorkflowStepSession(opts: {
  run: WorkflowRun;
  stepIndex: number;
  projectPath: string;
  stepDir: string;
  command: string;
  // The step's effective harness (run override, else the step's own) — tags
  // the graph presence node so it is drawn in that harness's color.
  harness: Workflow['steps'][number]['harness'];
  deps?: Partial<WorkflowStepSessionDeps>;
  // A Run tests step never errors the run: a failed spawn is handed here
  // (note + advance) instead of `markWorkflowStepSpawnErrored`. Called only
  // while the step is still the run's current one.
  onSpawnError?: (message: string) => void;
}): Promise<void> {
  const { run, stepIndex, projectPath, stepDir, command } = opts;
  const deps = { ...productionDeps, ...(opts.deps ?? {}) };
  const dedupeKey = workflowStepDedupeKey(run.id, stepIndex);
  const spawnRecord: WorkflowStepSpawnRecord = {
    runId: run.id,
    stepIndex,
    dedupeKey,
    deps,
  };
  stepSpawnRecords.set(recordKey(run.id, stepIndex), spawnRecord);

  const { done } = enqueueSpawn<void>({
    kind: 'workflow-step',
    priority: 'batch',
    dedupeKey,
    thunk: async () => {
      if (!isCurrentRunningStep(run, stepIndex)) {
        unregisterAgentSession(workflowStepAgentId(run.id, stepIndex));
        stepSpawnRecords.delete(recordKey(run.id, stepIndex));
        throw new Error(`workflow step ${run.id}/${stepIndex}: spawn cancelled`);
      }

      setStepPhase(run, stepIndex, 'spawning');
      await checkpointWorkflowRun(run);
      if (!isCurrentRunningStep(run, stepIndex)) throw new Error('workflow step spawn cancelled');
      spawnRecord.spawning = deps.proxyCreateSession({
        cwd: stepDir,
        initialCommand: command,
        projectPath,
        registry: { owner: 'workflow-step', label: `wf:step${stepIndex + 1}` },
      });
      const sess: CreateSessionResult = await spawnRecord.spawning;

      if (!isCurrentRunningStep(run, stepIndex)) {
        unregisterAgentSession(workflowStepAgentId(run.id, stepIndex));
        if ('id' in sess) {
          spawnRecord.serverId = sess.id;
          await killWorkflowStepServer(sess.id, deps);
        }
        stepSpawnRecords.delete(recordKey(run.id, stepIndex));
        throw new Error(`workflow step ${run.id}/${stepIndex}: spawn cancelled`);
      }

      if ('error' in sess) {
        if (sess.code === 'CAP') {
          setStepPhase(run, stepIndex, 'pending');
          await checkpointWorkflowRun(run);
          throw new SpawnCapacityError(
            `workflow step ${run.id}/${stepIndex}: terminal-server hard cap`,
          );
        }
        console.warn(
          `[workflow-run] ${run.id} step ${stepIndex}: pre-spawn failed: ${sess.error}`,
        );
        throw new Error(
          `workflow step ${run.id}/${stepIndex}: terminal session failed: ${sess.error}`,
        );
      }

      spawnRecord.serverId = sess.id;
      if (run.currentStepIndex === stepIndex) run.stepSessionId = sess.id;
      if (run.stepStates?.[stepIndex]) run.stepStates[stepIndex].sessionId = sess.id;
      if (stepPhase(run, stepIndex) !== 'completing') setStepPhase(run, stepIndex, 'running');
      try {
        await checkpointWorkflowRun(run);
      } catch (err) {
        // A returned session ID is owned by this spawn even if writing it
        // fails. Reclaim it before the queue reports a failed allocation.
        await killWorkflowStepServer(sess.id, deps);
        throw err;
      }
      if (!isCurrentRunningStep(run, stepIndex)) {
        await killWorkflowStepServer(sess.id, deps);
        return;
      }
      // Presence: an agent node for this non-worktree session, colored by
      // harness (Claude orange, Codex white, Pi blue). Every harness reports
      // activity (Claude hooks, Codex hooks.json, the Pi activity extension —
      // see stepSpawner.installStepCallbacks).
      registerAgentSession({
        agentId: workflowStepAgentId(run.id, stepIndex),
        projectPath,
        label: `workflow step ${stepIndex + 1}`,
        ...(opts.harness ? { harness: opts.harness } : {}),
      });

      notify({ type: 'progress', run: snapshot(run) });
      notify({
        type: 'step-spawned',
        runId: run.id,
        projectPath,
        stepIndex,
        command,
        cwd: stepDir,
        serverId: sess.id,
        terminalId: sess.terminalId,
      });
    },
  });
  // Fire-and-forget for production callers: CAP is retried inside the queue;
  // A rejected spawn can be a thrown setup/transport error as well as an
  // {error} response. Settle the workflow in both cases: swallowing a thrown
  // rejection here used to leave it permanently running without any PTY.
  // CAP never rejects `done`; the queue keeps it pending across retries.
  done.catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.onSpawnError) {
      forgetFailedStepSpawn(run, stepIndex);
      if (isCurrentRunningStep(run, stepIndex)) opts.onSpawnError(message);
      return;
    }
    markWorkflowStepSpawnErrored(run, stepIndex, message);
  });
  return done;
}
