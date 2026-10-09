// In-memory workflow-run registry + WS event fan-out.
//
// Holds the runs map, the listener set, and the snapshot/notify primitives
// the spawner and facade share. Splitting this from the orchestration logic
// keeps the WS event surface in one place — every payload that flows over
// `/ws/workflow-runs` is constructed from a `WorkflowRunEvent` here.

import { canonicalProjectPath } from '../projectPath.js';
import type { WorkflowRun, WorkflowRunEvent } from './types.js';
import { scheduleWorkflowRunPersist, writeWorkflowRunsNow } from './persistence.js';
import { snapshot } from './snapshot.js';
import { createEmitter } from '../emitter.js';

// Callers import snapshot from here too (it lives in the leaf snapshot.ts so
// persistence.ts needn't import this module).
export { snapshot };

// The run's wire types live in types.ts (node-free, re-exported to the
// frontend); re-exported here so existing `./state.js` importers keep working.
export type {
  RunTestsCheckpoint,
  WorkflowRun,
  WorkflowRunEvent,
  WorkflowRunStatus,
  WorkflowStepExecution,
} from './types.js';

export const runs = new Map<string, WorkflowRun>();
const events = createEmitter<[WorkflowRunEvent]>('workflow-run');


// A transition checkpoint is required before external work starts. Unlike the
// UI's best-effort debounce, failure must prevent an unrecorded side effect.
export async function checkpointWorkflowRun(run: WorkflowRun): Promise<void> {
  const records = getActiveRunsForProject(run.projectPath);
  if (run.status === 'running' && !records.some((r) => r.id === run.id)) records.push(snapshot(run));
  await writeWorkflowRunsNow(run.projectPath, records, true);
}

// Mirror this project's still-running runs to disk (debounced, best-effort).
// Called from `notify` for every run-carrying event and explicitly from
// `completeWorkflowStep` the moment it claims the next step index, so the
// on-disk record can never lag the in-memory one by more than one advance.
// See persistence.ts for why a run must survive the backend process.
export function persistRunsForProject(projectPath: string): void {
  scheduleWorkflowRunPersist(projectPath, () => getActiveRunsForProject(projectPath));
}

// Finished runs kept in `runs` per project. A finished run IS read by id after
// its terminal event: `GET /api/workflow-runs/:runId` (routes/workflows/runs.ts)
// serves it, and the frontend (`fetchWorkflowRun`, from `useWorkflowQueue`)
// asks when a run leaves its active set without a terminal WS event — missed
// while its socket was down — to tell "completed while disconnected" from
// "lost". So a finished run must stay readable until this bound evicts it;
// don't prune sooner. The bound itself exists because every terminal
// transition used to leave the run in the map for the life of the process, and
// each `getActiveRunsForProject` (called from every persist) then walked and
// cloned the whole history. Running runs are never pruned.
export const MAX_FINISHED_RUNS_PER_PROJECT = 20;

export function pruneFinishedRuns(projectPath: string): void {
  const key = canonicalProjectPath(projectPath);
  const finished = [...runs.values()]
    .filter((r) => r.projectPath === key && r.status !== 'running')
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
  for (const stale of finished.slice(MAX_FINISHED_RUNS_PER_PROJECT)) {
    runs.delete(stale.id);
  }
}

export function notify(ev: WorkflowRunEvent): void {
  if ('run' in ev) persistRunsForProject(ev.run.projectPath);
  if (ev.type === 'completed' || ev.type === 'errored' || ev.type === 'cancelled') {
    pruneFinishedRuns(ev.run.projectPath);
  }
  // Per-listener isolation. notify() is called inline from `dispatchStep`
  // (and other advance points) — if a single subscriber throws, the
  // exception used to bubble up to `completeWorkflowStep`'s try/catch and
  // error the workflow run mid-advance (symptom: workflow aborts the
  // instant we'd transition from an agent step into a control step,
  // because that path runs `notify({type:'progress'})` synchronously
  // before scheduling the control-step worker). A WS race, a closed
  // socket whose `ws.send` throws between the `readyState` check and
  // the send, or any future-added subscriber that throws under load
  // could silently break the entire workflow engine. Per-listener
  // try/catch (createEmitter) breaks that cascade.
  events.emit(ev);
}

export function subscribe(fn: (ev: WorkflowRunEvent) => void): () => void {
  return events.subscribe(fn);
}

// Does this task belong to the run's round? A legacy run without a recorded
// round counts every task, which is the conservative (wait-for-all) reading.
export function isRoundTask(run: WorkflowRun, taskId: string): boolean {
  return !run.roundTaskIds || run.roundTaskIds.includes(taskId);
}

// Add tasks to the run's round. Returns whether anything new was recorded, so
// the caller knows a checkpoint is owed. A legacy run keeps counting every task.
export function addRoundTasks(run: WorkflowRun, taskIds: string[]): boolean {
  if (!run.roundTaskIds) return false;
  const added = taskIds.filter((id) => !run.roundTaskIds!.includes(id));
  if (added.length === 0) return false;
  run.roundTaskIds = [...run.roundTaskIds, ...new Set(added)];
  return true;
}

export function getRun(id: string): WorkflowRun | null {
  const r = runs.get(id);
  return r ? snapshot(r) : null;
}

export function getActiveRunsForProject(projectPath: string): WorkflowRun[] {
  const key = canonicalProjectPath(projectPath);
  const out: WorkflowRun[] = [];
  for (const r of runs.values()) {
    if (r.projectPath === key && r.status === 'running') {
      out.push(snapshot(r));
    }
  }
  return out;
}

// Ids of every run currently `running`, optionally scoped to one project.
// The workflow-step scratch prune passes this in so it never deletes a live
// run's scratch dir (its Stop-hook completion config / task-creation helper)
// just because a burst of newer runs pushed it past the retention window —
// concurrent runs are allowed, and a run parked on a long agent step keeps a
// stale run-dir mtime. Run ids are globally unique, so the project filter is a
// precision nicety rather than a correctness requirement.
export function getRunningRunIds(projectPath?: string): Set<string> {
  const key = projectPath ? canonicalProjectPath(projectPath) : null;
  const out = new Set<string>();
  for (const r of runs.values()) {
    if (r.status !== 'running') continue;
    if (key && r.projectPath !== key) continue;
    out.add(r.id);
  }
  return out;
}
