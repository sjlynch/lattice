// Shared builders + a scenario harness for the queueScheduler suites, which are
// split by behaviour across queueScheduler.{reducer,pendingStarts,step,
// externalActive,preFinished}.test.ts.
//
// State machine (one workflow-queue instance):
//
//   idle ──startQueue (queued≥1)──▶ running ──auto-stop (drained)──▶ idle
//
// Each entry travels: queued ──dispatch──▶ started{runId:null} (in-flight)
//   ──workflowStarted──▶ started{runId} (active) ──runFinished──▶ retired.
//
//   • the queue is sequential: it dispatches one entry at a time and gates
//     behind any in-flight/active entry AND any externalActiveCount (a manual
//     ▶ Run the queue never tracked).
//   • `step()` = reduce + read pendingStarts + report autoStop in one shot; the
//     `starts` it returns are the entries the caller must actually dispatch.
//   • pre-finished race: a runFinished whose runId hasn't been attached yet is
//     buffered with its status in `preFinishedRuns` (bounded), then consumed
//     by the matching workflowStarted so a late /run resolve retires the entry
//     instead of attaching a dead id.
import type { WorkflowQueueEntry, WorkflowRunHarnessOverride, WorkflowRunStatus } from '../api/index.ts';
import {
  initialQueueState,
  reduceQueue,
  step,
  type QueueAction,
  type QueueState,
  type StartedEntry,
  type StepContext,
} from '../components/workflows/queueScheduler.ts';

export function queued(
  id: string,
  workflowId: string,
  harnessOverride: WorkflowRunHarnessOverride = null,
): WorkflowQueueEntry {
  return { id, workflowId, harnessOverride };
}

export function started(
  id: string,
  workflowId: string,
  runId: string | null,
  harnessOverride: WorkflowRunHarnessOverride = null,
): StartedEntry {
  return { ...queued(id, workflowId, harnessOverride), runId };
}

export function queueState(overrides: Partial<QueueState> = {}): QueueState {
  return {
    queued: [],
    running: false,
    started: [],
    preFinishedRuns: [],
    deferredRetry: null,
    ...overrides,
  };
}

export function entryIds(entries: Array<Pick<WorkflowQueueEntry, 'id'>>): string[] {
  return entries.map((entry) => entry.id);
}

export class QueueScenario {
  state: QueueState;
  starts: WorkflowQueueEntry[] = [];
  autoStop = false;
  // Simulated count of active runs the queue didn't dispatch (manual ▶ Run,
  // other tabs). Fed to `step` as the scheduler context for the methods that
  // route through it.
  externalActiveCount = 0;

  constructor(state: QueueState = initialQueueState) {
    this.state = state;
  }

  // Set the external-active-run count used by subsequent `step`-routed actions.
  externalActive(count: number): this {
    this.externalActiveCount = count;
    return this;
  }

  private ctx(): StepContext {
    return { externalActiveCount: this.externalActiveCount };
  }

  reduce(action: QueueAction): this {
    this.state = reduceQueue(this.state, action);
    this.clearStepResult();
    return this;
  }

  step(action: QueueAction): this {
    const result = step(this.state, action, this.ctx());
    this.state = result.state;
    this.starts = result.starts;
    this.autoStop = result.autoStop;
    return this;
  }

  enqueue(
    id: string,
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = null,
  ): this {
    return this.reduce({ type: 'enqueue', entry: queued(id, workflowId, harnessOverride) });
  }

  // Enqueue *through* the scheduler (not the raw reducer) so the
  // enqueue-while-busy auto-start rule can fire when `externalActive(n)` is set.
  enqueueStep(
    id: string,
    workflowId: string,
    harnessOverride: WorkflowRunHarnessOverride = null,
  ): this {
    return this.step({ type: 'enqueue', entry: queued(id, workflowId, harnessOverride) });
  }

  startQueue(): this {
    return this.step({ type: 'startQueue' });
  }

  stopQueue(): this {
    return this.step({ type: 'stopQueue' });
  }

  workflowStarted(entryId: string, runId: string): this {
    return this.step({ type: 'workflowStarted', entryId, runId });
  }

  dispatchFailed(entryId: string): this {
    return this.step({ type: 'dispatchFailed', entryId });
  }

  dispatchRejected(entryId: string): this {
    return this.step({ type: 'dispatchRejected', entryId });
  }

  runFinished(runId: string, status?: WorkflowRunStatus): this {
    return this.step({ type: 'runFinished', runId, status });
  }

  queuedIds(): string[] {
    return entryIds(this.state.queued);
  }

  startedIds(): string[] {
    return entryIds(this.state.started);
  }

  startIds(): string[] {
    return entryIds(this.starts);
  }

  private clearStepResult(): void {
    this.starts = [];
    this.autoStop = false;
  }
}

export function scenario(state?: QueueState): QueueScenario {
  return new QueueScenario(state);
}
