// Compact, model-facing views of workflow definitions and runs for the
// controller's workflow tools. A `WorkflowRun` carries its whole definition
// (every step prompt) and per-step summaries — far too much to re-read on every
// poll — so these keep each record's SCALAR fields (forward-compatible: a new
// override or per-step model/effort field shows up without a change here) and
// reduce prompts, summaries and variables to sizes. Pure; the shapes are read
// loosely (the wire types live in the backend, which this process must not
// import — see createServer.ts).

type Loose = Record<string, unknown>;

// Steps' summary text kept inline (a Run tests step's TEST_SUMMARY.md excerpt).
const SUMMARY_CLIP_CHARS = 600;

function isScalar(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function asObject(v: unknown): Loose | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined;
}

// Every scalar and string-array field except the named ones.
function scalars(obj: Loose, omit: readonly string[]): Loose {
  const out: Loose = {};
  for (const [k, v] of Object.entries(obj)) {
    if (omit.includes(k)) continue;
    if (isScalar(v)) out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
  }
  return out;
}

function stepView(step: Loose, index: number): Loose {
  const prompt = typeof step.prompt === 'string' ? step.prompt : '';
  return { index, ...scalars(step, ['id', 'prompt']), promptChars: prompt.length };
}

// A definition without its prompts (`get_workflow` returns them in full).
export function compactWorkflow(workflow: unknown): Loose {
  const wf = asObject(workflow) ?? {};
  const steps = Array.isArray(wf.steps) ? wf.steps : [];
  const variables = Array.isArray(wf.variables) ? wf.variables : [];
  return {
    ...scalars(wf, ['projectPath']),
    steps: steps.map((s, i) => stepView(asObject(s) ?? {}, i)),
    variables: variables.map((v) => asObject(v)?.name).filter((n) => typeof n === 'string'),
  };
}

// The phase of step `i` when the run has no per-step state for it (legacy
// serial runs, or a step not reached yet).
function derivedPhase(run: Loose, i: number): string {
  const current = typeof run.currentStepIndex === 'number' ? run.currentStepIndex : 0;
  if (run.status === 'completed') return 'completed';
  if (i < current) return 'completed';
  if (i > current) return 'pending';
  if (run.status === 'running') return typeof run.stepPhase === 'string' ? run.stepPhase : 'running';
  return String(run.status);
}

// Status, current step(s), per-step phase / error / summary excerpt; no
// definition, prompts or full summaries.
export function compactWorkflowRun(run: unknown): Loose {
  const r = asObject(run) ?? {};
  const out: Loose = scalars(r, ['projectPath']);
  if (typeof r.startedAt === 'number') {
    const end = typeof r.finishedAt === 'number' ? r.finishedAt : Date.now();
    out.elapsedSec = Math.round((end - r.startedAt) / 1000);
  }
  if (Array.isArray(r.activeStepIndices)) out.activeStepIndices = r.activeStepIndices;
  const stopReceived = asObject(r.stopReceived);
  if (stopReceived) out.stopReceived = stopReceived;

  const defSteps = Array.isArray(asObject(r.definition)?.steps)
    ? (asObject(r.definition)!.steps as unknown[])
    : [];
  const total = typeof r.totalSteps === 'number' ? r.totalSteps : defSteps.length;
  const states = asObject(r.stepStates) ?? {};
  const summaries = asObject(r.stepSummaries) ?? {};
  const steps: Loose[] = [];
  for (let i = 0; i < Math.max(total, defSteps.length); i++) {
    const def = asObject(defSteps[i]);
    const state = asObject(states[i]);
    const step: Loose = def ? stepView(def, i) : { index: i };
    delete step.promptChars;
    step.phase = typeof state?.phase === 'string' ? state.phase : derivedPhase(r, i);
    if (typeof state?.error === 'string') step.error = state.error;
    if (typeof state?.sessionId === 'string') step.sessionId = state.sessionId;
    const stopAt = asObject(state?.stopReceived)?.at;
    if (typeof stopAt === 'number') step.stopReceivedAt = stopAt;
    const summary = summaries[i];
    if (typeof summary === 'string' && summary) {
      step.summary =
        summary.length > SUMMARY_CLIP_CHARS ? `${summary.slice(0, SUMMARY_CLIP_CHARS)}…` : summary;
      step.summaryChars = summary.length;
    }
    steps.push(step);
  }
  out.steps = steps;
  return out;
}
