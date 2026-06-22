import type { WorkflowQueueEntry, WorkflowRunHarnessOverride } from '../api/index.ts';
import {
  initialQueueState,
  reduceQueue,
  step,
  type QueueAction,
  type QueueMode,
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
    mode: 'sequential',
    queued: [],
    running: false,
    started: [],
    preFinishedRunIds: [],
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

  setMode(mode: QueueMode): this {
    return this.reduce({ type: 'setMode', mode });
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

  runFinished(runId: string): this {
    return this.step({ type: 'runFinished', runId });
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
