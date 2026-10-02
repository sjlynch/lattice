// Durable workflow-run state.
//
// Why this exists: a workflow run used to live ONLY in `state.ts`'s in-memory
// `runs` map. The backend process that owns a run gets restarted routinely —
// `tsc -w` + the dev runner on any `backend/src` change, a crash, a
// processGuards fail-fast — and `scripts/dev.mjs` only defers a restart while a
// per-project `run.lock` is held, which covers CONTROL steps (start/merge/push)
// and nothing else. During a long **agent** step no lock is held, so a restart
// there silently evaporated the run:
//
//   - `GET /api/workflow-runs/active` returned [] → the navbar run chip vanished
//     (the observed symptom: "step 4 is in progress but the status is gone").
//   - The step's agent kept working — its pty lives in the DETACHED
//     terminal-server, which survives a backend restart — and when it finally
//     POSTed `/api/workflow-runs/<id>/steps/<n>/complete`, `completeWorkflowStep`
//     found no run and returned silently. Every remaining step (Start all open
//     tasks / Merge / Push) never ran.
//
// So the run record is now mirrored to disk and re-adopted on boot (see
// `../recovery/workflowRunResume.ts`). Only `running` runs are kept — a
// finished run has nothing to resume, so the file shrinks back to empty.
//
// Storage is HOME-scoped (`~/.lattice/per-project/<hash>/workflow-runs.json`),
// never inside the project tree: same reasoning as tasks.json (see the
// `.git`-deletion defences in the root CLAUDE.md). Writes are debounced and
// atomic (temp→rename), and every failure here is best-effort — losing the
// mirror must never break a live run.

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { canonicalProjectPath, homeProjectScratchDir } from '../projectPath.js';
import { snapshot, type WorkflowRun } from './state.js';
import { deserializeWorkflowRuns, serializeWorkflowRuns } from './runCodec.js';

// The pure (de)serialization codec lives in `runCodec.ts`; re-exported so the
// public surface of this module is unchanged.
export {
  WORKFLOW_RUNS_FILE_VERSION,
  serializeWorkflowRuns,
  deserializeWorkflowRun,
  deserializeWorkflowRuns,
} from './runCodec.js';

export const WORKFLOW_RUNS_FILENAME = 'workflow-runs.json';
// Matches the task cache's debounce: coalesce the burst of mutations a single
// step advance produces into one write.
export const WORKFLOW_RUNS_PERSIST_DEBOUNCE_MS = 100;

export function workflowRunsFile(projectPath: string): string {
  return homeProjectScratchDir(projectPath, WORKFLOW_RUNS_FILENAME);
}

// ---------------------------------------------------------------------------
// Disk IO — never throws.
// ---------------------------------------------------------------------------

export async function loadPersistedWorkflowRuns(projectPath: string): Promise<WorkflowRun[]> {
  const file = workflowRunsFile(projectPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    // ENOENT is the normal "this project never ran a workflow" case.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[workflow-run] failed to read ${file}:`, err);
    }
    return [];
  }
  try {
    return deserializeWorkflowRuns(JSON.parse(raw), projectPath);
  } catch (err) {
    // A truncated/corrupt mirror is not worth preserving (unlike tasks.json,
    // it is derived state that a live run rewrites within milliseconds) — but
    // it must not throw into boot recovery.
    console.error(`[workflow-run] ignoring unparseable ${file}:`, err);
    return [];
  }
}

const writesInFlight = new Map<string, Promise<void>>();

export async function writeWorkflowRunsNow(
  projectPath: string,
  runs: WorkflowRun[],
  required = false,
): Promise<void> {
  const key = canonicalProjectPath(projectPath);
  // Atomic rename protects a single write, not its ordering against another
  // write or deletion. Serialize per project so a slow running-state write
  // cannot resurrect a completed workflow after its newer removal finishes.
  const previous = writesInFlight.get(key) ?? Promise.resolve();
  const records = runs.map(snapshot);
  const write = previous.catch(() => {}).then(() => writeWorkflowRunsFile(key, records, required));
  const settled = write.catch(() => {});
  writesInFlight.set(key, settled);
  try {
    await write;
  } finally {
    if (writesInFlight.get(key) === settled) writesInFlight.delete(key);
  }
}

async function writeWorkflowRunsFile(
  projectPath: string,
  runs: WorkflowRun[],
  required: boolean,
): Promise<void> {
  const file = workflowRunsFile(projectPath);
  try {
    if (runs.length === 0) {
      // Nothing running: drop the file instead of leaving an empty husk that
      // boot recovery has to open for every project, every boot.
      await fs.rm(file, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, serializeWorkflowRuns(runs));
  } catch (err) {
    console.error(`[workflow-run] failed to persist ${file}:`, err);
    if (required) throw err;
  }
}

// ---------------------------------------------------------------------------
// Debounced write scheduling
// ---------------------------------------------------------------------------

type PendingWrite = {
  timer: ReturnType<typeof setTimeout>;
  collect: () => WorkflowRun[];
};

const pendingWrites = new Map<string, PendingWrite>();

// Schedule a debounced mirror of `collect()`'s result for one project.
// `collect` is re-invoked at flush time (not now) so the write always reflects
// the latest state rather than a snapshot taken mid-advance.
export function scheduleWorkflowRunPersist(
  projectPath: string,
  collect: () => WorkflowRun[],
): void {
  const key = canonicalProjectPath(projectPath);
  const existing = pendingWrites.get(key);
  if (existing) {
    existing.collect = collect;
    return; // leading-edge debounce: the already-armed timer will flush it
  }
  const timer = setTimeout(() => {
    const entry = pendingWrites.get(key);
    pendingWrites.delete(key);
    if (!entry) return;
    void writeWorkflowRunsNow(key, entry.collect());
  }, WORKFLOW_RUNS_PERSIST_DEBOUNCE_MS);
  timer.unref?.();
  pendingWrites.set(key, { timer, collect });
}

// Flush any pending debounced write immediately. Used by tests; also safe to
// call from a shutdown path.
export async function flushWorkflowRunPersist(projectPath?: string): Promise<void> {
  const keys = projectPath
    ? [canonicalProjectPath(projectPath)]
    : [...new Set([...pendingWrites.keys(), ...writesInFlight.keys()])];
  for (const key of keys) {
    const entry = pendingWrites.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      pendingWrites.delete(key);
      await writeWorkflowRunsNow(key, entry.collect());
    } else {
      // A timer may already have handed its write to the filesystem. A flush
      // still has to wait for that write, even though there is no timer left.
      await writesInFlight.get(key);
    }
  }
}
