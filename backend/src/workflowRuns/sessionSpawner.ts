// Spawn-queue orchestration + agent-session registration for a workflow
// step's terminal. The step dir is already materialized by the coordinator
// (stepSpawner.ts); this module only routes the pty allocation through the
// spawn queue and, for a Claude step, registers the orange presence node.

import { proxyCreateSession, proxyKillSession } from '../terminalProxy.js';
import type { CreateSessionResult } from '../terminalServerClient.js';
import { cancelSpawn, enqueueSpawn, notifySessionsFreed, SpawnCapacityError } from '../spawnQueue.js';
import { registerAgentSession, unregisterAgentSession } from '../agentSessions.js';
import type { Workflow } from '../workflows.js';
import { notify, snapshot, type WorkflowRun } from './state.js';

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
};

const stepSpawnRecords = new Map<string, WorkflowStepSpawnRecord>();

function recordKey(runId: string, stepIndex: number): string {
  return `${runId}:${stepIndex}`;
}

function isCurrentRunningStep(run: WorkflowRun, stepIndex: number): boolean {
  return run.status === 'running' && run.currentStepIndex === stepIndex;
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

function markWorkflowStepSpawnErrored(
  run: WorkflowRun,
  stepIndex: number,
  error: string,
): void {
  unregisterAgentSession(workflowStepAgentId(run.id, stepIndex));
  stepSpawnRecords.delete(recordKey(run.id, stepIndex));
  // A queued spawn may settle after cancellation or after a stale completion
  // callback advanced the run. In that case, do not overwrite the terminal
  // state; just make sure any speculative presence node is gone.
  if (!isCurrentRunningStep(run, stepIndex)) return;
  run.status = 'errored';
  run.finishedAt = Date.now();
  run.error = `workflow step ${stepIndex + 1} failed to spawn: ${error}`;
  notify({ type: 'errored', run: snapshot(run) });
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
  deps: Pick<WorkflowStepSessionDeps, 'proxyKillSession'> = productionDeps,
): Promise<void> {
  const key = recordKey(runId, stepIndex);
  const record = stepSpawnRecords.get(key);
  stepSpawnRecords.delete(key);
  if (!record?.serverId) return;
  try {
    await killWorkflowStepServer(record.serverId, deps);
  } catch (err) {
    console.warn(
      `[workflow-run] ${runId} step ${stepIndex}: kill session ${record.serverId} on advance failed:`,
      err,
    );
  }
}

export function cancelWorkflowStepSessions(
  runId: string,
  deps: Pick<WorkflowStepSessionDeps, 'proxyKillSession'> = productionDeps,
): void {
  const records = [...stepSpawnRecords.values()].filter((record) => record.runId === runId);
  for (const record of records) {
    cancelSpawn(record.dedupeKey);
    unregisterAgentSession(workflowStepAgentId(record.runId, record.stepIndex));
    if (record.serverId) {
      void killWorkflowStepServer(record.serverId, deps).catch((err) => {
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
  harness: Workflow['steps'][number]['harness'];
  deps?: Partial<WorkflowStepSessionDeps>;
}): Promise<void> {
  const { run, stepIndex, projectPath, stepDir, command, harness } = opts;
  const deps = { ...productionDeps, ...(opts.deps ?? {}) };
  const dedupeKey = workflowStepDedupeKey(run.id, stepIndex);
  const spawnRecord: WorkflowStepSpawnRecord = {
    runId: run.id,
    stepIndex,
    dedupeKey,
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

      const sess: CreateSessionResult = await deps.proxyCreateSession({
        cwd: stepDir,
        initialCommand: command,
        projectPath,
      });

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
          throw new SpawnCapacityError(
            `workflow step ${run.id}/${stepIndex}: terminal-server hard cap`,
          );
        }
        console.warn(
          `[workflow-run] ${run.id} step ${stepIndex}: pre-spawn failed: ${sess.error}`,
        );
        markWorkflowStepSpawnErrored(run, stepIndex, sess.error);
        throw new Error(
          `workflow step ${run.id}/${stepIndex}: terminal session failed: ${sess.error}`,
        );
      }

      spawnRecord.serverId = sess.id;
      if (harness === 'claude') {
        // Presence: orange Claude node for this non-worktree session. Claude
        // only — a Pi/codex step isn't a "Claude session" and never fires the
        // activity hooks, so it gets no node.
        registerAgentSession({
          agentId: workflowStepAgentId(run.id, stepIndex),
          projectPath,
          label: `workflow step ${stepIndex + 1}`,
        });
      }

      notify({
        type: 'step-spawned',
        runId: run.id,
        projectPath,
        stepIndex,
        command,
        cwd: stepDir,
        serverId: sess.id,
      });
    },
  });
  // Fire-and-forget for production callers: CAP is retried inside the queue;
  // a genuine terminal-server/session failure marks the workflow errored above
  // and rejects `done` so the queue releases its concurrency reservation.
  done.catch(() => {});
  return done;
}
