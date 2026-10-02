// The workflow-run mirror's codec: the `workflow-runs.json` file shape and the
// pure (de)serialization of run records. No disk IO — `persistence.ts` owns
// the read/write/debounce side and re-exports everything public here.
//
// The disk format is untrusted input on the way back in, so every field is
// re-validated rather than trusted from JSON.parse. Legacy records (older file
// versions, missing fields) and corrupt ones are normalized here: a record too
// damaged to resume is dropped, and invalid definition / execution state is
// kept as an explicit `definitionError` rather than silently replaced.

import { canonicalProjectPath } from '../projectPath.js';
import { matchesStoredProjectIdentity } from '../projectIdentity.js';
import { normalizePiModel } from '../agentCommandBuilder.js';
import { normalizeWorkflowRunHarnessOverride } from '../workflows/normalization.js';
import type { WorkflowRun, WorkflowStepExecution } from './state.js';
import { nextStepGroup } from './execution.js';
import { readWorkflowDefinition } from './definition.js';

export const WORKFLOW_RUNS_FILE_VERSION = 3;

type WorkflowRunsFile = {
  version: number;
  runs: WorkflowRun[];
};

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
export function deserializeWorkflowRun(raw: unknown, owningProject?: string): WorkflowRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const workflowId = str(r.workflowId);
  const projectPath = str(r.projectPath);
  const currentStepIndex = num(r.currentStepIndex);
  const totalSteps = num(r.totalSteps);
  if (!id || !workflowId || !projectPath) return null;
  if (owningProject && !matchesStoredProjectIdentity(projectPath, owningProject)) return null;
  if (currentStepIndex === undefined || currentStepIndex < 0) return null;
  if (r.status !== 'running') return null;

  const run: WorkflowRun = {
    id,
    workflowId,
    workflowName: str(r.workflowName) ?? workflowId,
    projectPath: canonicalProjectPath(owningProject ?? projectPath),
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
  if (r.definition !== undefined) {
    run.definition = readWorkflowDefinition(r.definition, workflowId, run.projectPath);
    // Preserve an invalid snapshot as an explicit failed definition. Never
    // replace it with an edited workflow on the next recovery.
    if (!run.definition) run.definitionError = 'persisted workflow definition is invalid; inspect workflow-runs.json before retrying';
  }
  if (str(r.definitionError)) run.definitionError = str(r.definitionError);
  if (['pending', 'spawning', 'running', 'completing'].includes(String(r.stepPhase))) {
    run.stepPhase = r.stepPhase as WorkflowRun['stepPhase'];
  }
  const sessionId = str(r.stepSessionId);
  if (sessionId) run.stepSessionId = sessionId;
  // An unreadable round falls back to the legacy "every task counts" wait:
  // the Merge step then waits for more work, never merges a round early.
  if (Array.isArray(r.roundTaskIds)) {
    run.roundTaskIds = [...new Set(r.roundTaskIds.filter((id): id is string => !!str(id)))];
  }
  const summaries = readStepSummaries(r.stepSummaries);
  if (summaries) run.stepSummaries = summaries;
  const testStep = readTestStepCheckpoint(r.testStep);
  if (testStep) run.testStep = testStep;
  const stopReceived = readStopReceived(r.stopReceived);
  if (stopReceived) run.stopReceived = stopReceived;
  if (r.stepStates !== undefined || r.activeStepIndices !== undefined || r.groupEndIndex !== undefined) {
    if (!readExecutionState(run, r)) {
      run.definitionError = 'persisted workflow execution state is invalid; inspect workflow-runs.json before retrying';
    }
  }
  return run;
}

function readExecutionState(run: WorkflowRun, raw: Record<string, unknown>): boolean {
  const wf = run.definition;
  const indices = raw.activeStepIndices;
  const end = num(raw.groupEndIndex);
  const states = raw.stepStates;
  if (!wf || !Number.isSafeInteger(run.currentStepIndex) || !Array.isArray(indices) || !indices.length || !Number.isSafeInteger(end) ||
      !states || typeof states !== 'object' || Array.isArray(states)) return false;
  const group = nextStepGroup(wf.steps, run.currentStepIndex);
  if (!group || group.indices[0] !== run.currentStepIndex || end !== group.end ||
      JSON.stringify(indices) !== JSON.stringify(group.indices)) return false;
  const entries = Object.entries(states);
  if (entries.length !== wf.steps.length || run.totalSteps !== wf.steps.length) return false;
  const out: Record<number, WorkflowStepExecution> = {};
  for (const [key, value] of entries) {
    const index = Number(key);
    if (!Number.isSafeInteger(index) || String(index) !== key || !wf.steps[index] || !value || typeof value !== 'object') return false;
    const s = value as Record<string, unknown>;
    if (s.stepId !== wf.steps[index].id || !['pending', 'spawning', 'running', 'completing', 'completed', 'skipped'].includes(String(s.phase))) return false;
    if ((s.phase === 'skipped') !== (wf.steps[index].frozen === true)) return false;
    if (!indices.includes(index) && s.phase !== (wf.steps[index].frozen ? 'skipped' : index < run.currentStepIndex ? 'completed' : 'pending')) return false;
    const stop = readStopReceived(s.stopReceived);
    if (s.stopReceived !== undefined && (!stop || stop.stepIndex !== index)) return false;
    out[index] = { stepId: String(s.stepId), phase: s.phase as WorkflowStepExecution['phase'],
      ...(str(s.sessionId) ? { sessionId: str(s.sessionId) } : {}),
      ...(stop ? { stopReceived: stop } : {}), ...(str(s.error) ? { error: str(s.error) } : {}) };
  }
  run.activeStepIndices = [...indices] as number[];
  run.groupEndIndex = end;
  run.stepStates = out;
  // Per-member state is authoritative; keep the legacy singleton mirrors in
  // sync even if a hand-edited checkpoint omits or contradicts them.
  const anchor = out[run.currentStepIndex];
  run.stepPhase = ['pending', 'spawning', 'running', 'completing'].includes(anchor.phase)
    ? anchor.phase as WorkflowRun['stepPhase'] : undefined;
  run.stepSessionId = anchor.sessionId;
  run.stopReceived = anchor.stopReceived;
  return true;
}

function readStopReceived(raw: unknown): WorkflowRun['stopReceived'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Record<string, unknown>;
  const stepIndex = num(s.stepIndex);
  const at = num(s.at);
  if (stepIndex === undefined || !Number.isInteger(stepIndex) || stepIndex < 0 || at === undefined) return undefined;
  const activeAt = num(s.activeAt);
  return {
    stepIndex,
    at,
    ...(activeAt !== undefined ? { activeAt } : {}),
    ...(typeof s.busy === 'boolean' ? { busy: s.busy } : {}),
  };
}

// Per-step summaries (Run tests). Display text only — keep string values under
// integer keys and drop anything else.
function readStepSummaries(raw: unknown): Record<number, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<number, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && typeof value === 'string') out[index] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

function readTestStepCheckpoint(raw: unknown): WorkflowRun['testStep'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  const stepIndex = num(t.stepIndex);
  if (stepIndex === undefined || !Number.isInteger(stepIndex) || stepIndex < 0) return undefined;
  // A HEAD sha later lands in a git revision range: accept hex only.
  const startHead = typeof t.startHead === 'string' && /^[0-9a-f]{7,64}$/i.test(t.startHead) ? t.startHead : null;
  const spawnedAt = num(t.spawnedAt);
  return { stepIndex, startHead, ...(spawnedAt !== undefined ? { spawnedAt } : {}) };
}

export function deserializeWorkflowRuns(raw: unknown, owningProject?: string): WorkflowRun[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as WorkflowRunsFile).runs)
      ? (raw as WorkflowRunsFile).runs
      : null;
  if (!list) return [];
  const out: WorkflowRun[] = [];
  for (const entry of list) {
    const run = deserializeWorkflowRun(entry, owningProject);
    if (run) out.push(run);
  }
  return out;
}
