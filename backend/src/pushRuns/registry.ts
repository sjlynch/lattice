import {
  createOneOffRunRegistry,
  type OneOffRunRegistryEvent,
  type OneOffRunRegistryListener,
} from '../homeScratch/registry.js';
import {
  createOneOffRunStore,
  readNumber,
  readString,
} from '../homeScratch/persistence.js';
import { canonicalProjectPath } from '../projectPath.js';
import { pushPaths } from './paths.js';
import type { PushRun } from './types.js';

export type PushRunEvent = OneOffRunRegistryEvent<PushRun>;
type PushRunListener = OneOffRunRegistryListener<PushRun>;

export const PUSH_RUNS_FILENAME = 'push-runs.json';

// Rebuild a persisted run from untrusted JSON. Only `running` runs are
// resumable. The cwd is re-derived through the scratch path guard from the
// (regex-checked) id rather than trusted from disk: boot recovery matches the
// live pty by it and cleanup deletes it.
export function deserializePushRun(raw: unknown, owningProject: string): PushRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = readString(r.id);
  if (!id || r.status !== 'running') return null;
  let cwd: string;
  let projectPath: string;
  try {
    projectPath = canonicalProjectPath(owningProject);
    cwd = pushPaths.assertSafeSessionPath(projectPath, id);
  } catch {
    return null;
  }
  const run: PushRun = {
    id,
    projectPath,
    cwd,
    status: 'running',
    createdAt: readNumber(r.createdAt) ?? 0,
  };
  const serverId = readString(r.serverId);
  if (serverId) run.serverId = serverId;
  const workflowRunId = readString(r.workflowRunId);
  const workflowStepIndex = readNumber(r.workflowStepIndex);
  if (workflowRunId && workflowStepIndex !== undefined && Number.isInteger(workflowStepIndex) && workflowStepIndex >= 0) {
    run.workflowRunId = workflowRunId;
    run.workflowStepIndex = workflowStepIndex;
  }
  return run;
}

// `~/.lattice/per-project/<hash>/push-runs.json` — every still-running push
// run, re-adopted on boot by `recovery/oneOffRunResume.ts`.
export const pushRunStore = createOneOffRunStore<PushRun>({
  fileName: PUSH_RUNS_FILENAME,
  logLabel: '[pushRuns]',
  deserialize: deserializePushRun,
});

const registry = createOneOffRunRegistry<PushRun>({
  logLabel: '[pushRuns]',
  emitEvents: true,
  store: pushRunStore,
});

export function getPushRun(id: string): PushRun | undefined {
  return registry.get(id);
}

export function recordPushRun(run: PushRun): void {
  registry.record(run);
}

export function markPushRunDone(id: string): boolean {
  return registry.markDone(id);
}

// Settle a run whose terminal died without calling `/done`: flag it `lost`
// (so a waiting workflow Push step fails instead of reporting success), then
// mark it done — which fans out the 'done' event that unblocks that waiter.
export function markPushRunLost(id: string): boolean {
  if (!registry.update(id, { lost: true })) return false;
  return registry.markDone(id);
}

// Boot recovery: put a persisted still-running run back so its `/done`
// callback (and a re-dispatched workflow Push step) finds it.
export function restorePushRun(run: PushRun): boolean {
  return registry.restore(run);
}

// The still-running push session a workflow's Push step spawned, if any. Used
// by a re-dispatched Push step to attach instead of pushing twice. A run whose
// pty boot recovery already found gone (`lost`, awaiting settlement) is not
// attachable — nothing is left to wait for, so the step pushes afresh.
export function findRunningPushRunForWorkflowStep(
  workflowRunId: string,
  stepIndex: number,
): PushRun | undefined {
  return registry
    .list()
    .find(
      (r) =>
        r.status === 'running' &&
        !r.lost &&
        r.workflowRunId === workflowRunId &&
        r.workflowStepIndex === stepIndex,
    );
}

// Forget the run after the frontend has acknowledged completion. Keeps the
// in-memory map from growing across long sessions.
//
// IMPORTANT: never drop a run that is still `running`. The frontend status
// poller calls this (via DELETE /api/push-runs/:id) whenever it sees the run
// finished — and a *transient* `GET /api/push-runs/:id` hiccup is
// indistinguishable from "the run is gone". Honoring that for a live run would
// delete it from the registry before its Stop hook posts `/done`, so the later
// `markPushRunDone` finds no run (returns false, emits no 'done' event) and any
// 'done'-event waiter (the workflow Push control step) hangs. A live run is
// only ever forgotten after its Stop hook has marked it `done`; an unknown id
// is a harmless no-op. Mirrors forgetQaRun.
export function forgetPushRun(id: string): void {
  registry.forget(id);
}

// Subscribe to push-run lifecycle events. Used by the workflow Push control
// step to await the 'done' event without polling.
export function subscribePushRuns(fn: PushRunListener): () => void {
  return registry.subscribe(fn);
}
