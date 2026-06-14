// Spawn-queue orchestration + agent-session registration for a workflow
// step's terminal. The step dir is already materialized by the coordinator
// (stepSpawner.ts); this module only routes the pty allocation through the
// spawn queue and, for a Claude step, registers the orange presence node.

import { proxyCreateSession } from '../terminalProxy.js';
import { enqueueSpawn, SpawnCapacityError } from '../spawnQueue.js';
import { registerAgentSession } from '../agentSessions.js';
import type { Workflow } from '../workflows.js';
import { notify, type WorkflowRun } from './state.js';

// Stable graph-node id for a workflow-step session. A new id per step, so
// advancing the run swaps one node for the next.
export function workflowStepAgentId(runId: string, stepIndex: number): string {
  return `wf:${runId}:${stepIndex}`;
}

// Route the pty allocation through the spawn queue (fire-and-forget, like
// task runs): the step dir is materialized by the caller, only the pty waits
// for concurrency headroom. `step-spawned` fires from inside the thunk so it
// naturally lands when the queue admits the step, and the frontend
// (useWorkflowRuns) lazy-mounts the terminal off that event — exactly the
// pre-queue flow, just deferred.
export function enqueueWorkflowStepSession(opts: {
  run: WorkflowRun;
  stepIndex: number;
  projectPath: string;
  stepDir: string;
  command: string;
  harness: Workflow['steps'][number]['harness'];
}): void {
  const { run, stepIndex, projectPath, stepDir, command, harness } = opts;
  const { done } = enqueueSpawn<void>({
    kind: 'workflow-step',
    priority: 'batch',
    dedupeKey: `wf-step:${run.id}:${stepIndex}`,
    thunk: async () => {
      const sess = await proxyCreateSession({
        cwd: stepDir,
        initialCommand: command,
        projectPath,
      });
      if ('error' in sess) {
        if (sess.code === 'CAP') {
          throw new SpawnCapacityError(
            `workflow step ${run.id}/${stepIndex}: terminal-server hard cap`,
          );
        }
        console.warn(
          `[workflow-run] ${run.id} step ${stepIndex}: pre-spawn failed: ${sess.error}`,
        );
      }
      if ('id' in sess && harness === 'claude') {
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
        serverId: 'id' in sess ? sess.id : undefined,
      });
    },
  });
  // Fire-and-forget: the thunk handles its own errors (CAP is retried inside
  // the queue). Swallow the rejection so it is not an unhandled rejection.
  done.catch(() => {});
}
