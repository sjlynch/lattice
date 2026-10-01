import type { WorkflowRun, WorkflowStep } from '../../api';

function marked(step: WorkflowStep | undefined): boolean {
  return (step?.kind ?? 'agent') === 'agent' && step?.parallel === true;
}

export function parallelGroupAt(steps: WorkflowStep[], index: number): { start: number; end: number } | null {
  if (!marked(steps[index])) return null;
  let start = index;
  let end = index + 1;
  while (start > 0 && marked(steps[start - 1])) start--;
  while (end < steps.length && marked(steps[end])) end++;
  return end - start > 1 ? { start, end } : null;
}

export function workflowRunProgress(run: WorkflowRun): { text: string; percent: number } {
  const states = run.stepStates ? Object.values(run.stepStates) : null;
  const runnable = states?.filter((s) => s.phase !== 'skipped');
  const completed = runnable?.filter((s) => s.phase === 'completed').length ?? 0;
  const percent = runnable ? (runnable.length ? Math.round(completed / runnable.length * 100) : 100)
    : run.totalSteps ? Math.round(Math.min(run.currentStepIndex + 1, run.totalSteps) / run.totalSteps * 100) : 0;
  const members = run.activeStepIndices ?? [run.currentStepIndex];
  if (members.length > 1 && run.stepStates) {
    const current = members.map((i) => run.stepStates![i]);
    const running = current.filter((s) => s.phase === 'running' || s.phase === 'completing').length;
    const queued = current.filter((s) => s.phase === 'pending' || s.phase === 'spawning').length;
    const done = current.filter((s) => s.phase === 'completed').length;
    return { text: `Parallel reviews: ${running} running${queued ? `, ${queued} queued` : ''}, ${done} complete`, percent };
  }
  return { text: `Step ${Math.min(run.currentStepIndex + 1, run.totalSteps)} of ${run.totalSteps}`, percent };
}
