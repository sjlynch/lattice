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
import { normalizePiModel } from '../agentCommandBuilder.js';
import { normalizeWorkflowRunHarnessOverride } from '../workflows/normalization.js';
import type { WorkflowRun } from './state.js';

export const WORKFLOW_RUNS_FILENAME = 'workflow-runs.json';
export const WORKFLOW_RUNS_FILE_VERSION = 1;
// Matches the task cache's debounce: coalesce the burst of mutations a single
// step advance produces into one write.
export const WORKFLOW_RUNS_PERSIST_DEBOUNCE_MS = 100;

type WorkflowRunsFile = {
  version: number;
  runs: WorkflowRun[];
};

export function workflowRunsFile(projectPath: string): string {
  return homeProjectScratchDir(projectPath, WORKFLOW_RUNS_FILENAME);
}

// ---------------------------------------------------------------------------
// Pure (de)serialization — the disk format is untrusted input on the way back
// in, so every field is re-validated rather than trusted from JSON.parse.
// ---------------------------------------------------------------------------

export function serializeWorkflowRuns(runs: WorkflowRun[]): string {
  const body: WorkflowRunsFile = { version: WORKFLOW_RUNS_FILE_VERSION, runs };
  return JSON.stringify(body, null, 2);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// Reconstruct one run record, or null if it is too damaged to resume. We only
// ever persist `running` runs, but a hand-edited/old file could hold anything;
// anything that isn't `running` is dropped here rather than at the call site.
export function deserializeWorkflowRun(raw: unknown): WorkflowRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const workflowId = str(r.workflowId);
  const projectPath = str(r.projectPath);
  const currentStepIndex = num(r.currentStepIndex);
  const totalSteps = num(r.totalSteps);
  if (!id || !workflowId || !projectPath) return null;
  if (currentStepIndex === undefined || currentStepIndex < 0) return null;
  if (r.status !== 'running') return null;

  const run: WorkflowRun = {
    id,
    workflowId,
    workflowName: str(r.workflowName) ?? workflowId,
    projectPath: canonicalProjectPath(projectPath),
    status: 'running',
    startedAt: num(r.startedAt) ?? 0,
    totalSteps: totalSteps !== undefined && totalSteps > 0 ? totalSteps : 0,
    currentStepIndex,
  };
  // Both overrides end up in a spawned harness command, so they are re-validated
  // through the same normalizers the HTTP path uses rather than trusted from
  // JSON — this file is on disk and could be stale, hand-edited, or corrupt.
  // (`normalizePiModel` is the `provider/model[:thinking]` shell-injection
  // guard; `buildPiModelFlag` re-checks at the flag site, this is the boundary.)
  const harnessOverride = normalizeWorkflowRunHarnessOverride(r.harnessOverride);
  if (harnessOverride) run.harnessOverride = harnessOverride;
  const piModelOverride = normalizePiModel(r.piModelOverride);
  if (piModelOverride) run.piModelOverride = piModelOverride;
  return run;
}

export function deserializeWorkflowRuns(raw: unknown): WorkflowRun[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as WorkflowRunsFile).runs)
      ? (raw as WorkflowRunsFile).runs
      : null;
  if (!list) return [];
  const out: WorkflowRun[] = [];
  for (const entry of list) {
    const run = deserializeWorkflowRun(entry);
    if (run) out.push(run);
  }
  return out;
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
    return deserializeWorkflowRuns(JSON.parse(raw));
  } catch (err) {
    // A truncated/corrupt mirror is not worth preserving (unlike tasks.json,
    // it is derived state that a live run rewrites within milliseconds) — but
    // it must not throw into boot recovery.
    console.error(`[workflow-run] ignoring unparseable ${file}:`, err);
    return [];
  }
}

export async function writeWorkflowRunsNow(
  projectPath: string,
  runs: WorkflowRun[],
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
  const keys = projectPath ? [canonicalProjectPath(projectPath)] : [...pendingWrites.keys()];
  for (const key of keys) {
    const entry = pendingWrites.get(key);
    if (!entry) continue;
    clearTimeout(entry.timer);
    pendingWrites.delete(key);
    await writeWorkflowRunsNow(key, entry.collect());
  }
}
