import { createOneOffRunRegistry } from '../homeScratch/registry.js';
import {
  createOneOffRunStore,
  readNumber,
  readRunningRecordIdentity,
  readString,
} from '../homeScratch/persistence.js';
import { qaPaths } from './paths.js';
import type { QaRun, QaVerdict } from './types.js';

export const QA_RUNS_FILENAME = 'qa-runs.json';

// Rebuild a persisted run from untrusted JSON. Only `running` runs are
// resumable. As for push runs, the cwd is re-derived through the scratch path
// guard from the (regex-checked) id rather than trusted from disk. The
// recorded verdict survives, so a `/done` (or boot recovery settling a dead
// session) after a restart can still promote a confident PASS qa → done.
export function deserializeQaRun(raw: unknown, owningProject: string): QaRun | null {
  const identity = readRunningRecordIdentity(raw, owningProject, qaPaths);
  if (!identity) return null;
  const { record: r, id, projectPath, cwd } = identity;
  const taskId = readString(r.taskId);
  if (!taskId) return null;
  const run: QaRun = {
    id,
    taskId,
    projectPath,
    cwd,
    status: 'running',
    createdAt: readNumber(r.createdAt) ?? 0,
  };
  const serverId = readString(r.serverId);
  if (serverId) run.serverId = serverId;
  const v = r.verdict as Record<string, unknown> | undefined;
  if (v && typeof v === 'object' && typeof v.passed === 'boolean' && typeof v.confident === 'boolean') {
    run.verdict = { passed: v.passed, confident: v.confident, receivedAt: readNumber(v.receivedAt) ?? 0 };
  }
  if (r.movedToDone === true) run.movedToDone = true;
  return run;
}

// `~/.lattice/per-project/<hash>/qa-runs.json` — every still-running QA run,
// re-adopted on boot by `recovery/oneOffRunResume.ts`.
export const qaRunStore = createOneOffRunStore<QaRun>({
  fileName: QA_RUNS_FILENAME,
  logLabel: '[qaRuns]',
  deserialize: deserializeQaRun,
});

// QA e2e-run registry. Like pushRuns, running runs are mirrored to disk (see
// ../homeScratch/persistence.ts) and put back by boot recovery when their
// session survived the restart; everything else on disk is swept.
const registry = createOneOffRunRegistry<QaRun>({
  logLabel: '[qaRuns]',
  store: qaRunStore,
});

export function getQaRun(id: string): QaRun | undefined {
  return registry.get(id);
}

// Every still-running run (clones). The start guard reads it to refuse a second
// session for a task that is already under test.
export function listRunningQaRuns(): QaRun[] {
  return registry.list().filter((r) => r.status === 'running');
}

export function recordQaRun(run: QaRun): void {
  registry.record(run);
}

export function markQaRunDone(id: string): boolean {
  return registry.markDone(id);
}

// Stash the agent's reported verdict on the run (and mirror it, so a restart
// before `/done` keeps it). No-op if the run is unknown.
export function recordQaVerdict(id: string, verdict: QaVerdict): void {
  registry.update(id, { verdict });
}

// Flag that a confident pass promoted this run's task to Done.
export function markQaRunMovedToDone(id: string): void {
  registry.update(id, { movedToDone: true });
}

// Record the resolved terminal auto-close decision (from
// UserSettings.qaTerminalAutoClose) so the frontend poller can mirror it when
// it next sees `done`. No-op if the run is unknown.
export function recordQaRunAutoClose(id: string, autoClose: boolean): void {
  registry.update(id, { autoCloseTerminal: autoClose });
}

// Boot recovery: put a persisted still-running run back so its `/verdict` and
// `/done` callbacks find it.
export function restoreQaRun(run: QaRun): boolean {
  return registry.restore(run);
}

// Forget the run once the frontend has acknowledged completion — keeps the
// in-memory map from growing across long sessions.
//
// IMPORTANT: never drop the run while still `running`; a transient status-poll
// failure must not make the later /verdict or /done callback look untracked.
export function forgetQaRun(id: string): void {
  registry.forget(id);
}
