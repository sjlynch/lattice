import type { WorkflowStep } from '../workflows.js';
import type { WorkflowRun, WorkflowStepExecution } from './state.js';

export function isParallelStep(step: WorkflowStep | undefined): boolean {
  return (step?.kind ?? 'agent') === 'agent' && step?.parallel === true;
}

// Form boundaries BEFORE skipping frozen members. A frozen serial separator
// still separates groups; a frozen parallel member stays in its authored group.
export function nextStepGroup(steps: WorkflowStep[], from: number): { indices: number[]; end: number } | null {
  let start = Math.max(0, from);
  while (start < steps.length) {
    let end = start + 1;
    if (isParallelStep(steps[start])) {
      while (end < steps.length && isParallelStep(steps[end])) end++;
    }
    const indices = Array.from({ length: end - start }, (_, i) => start + i)
      .filter((i) => steps[i].frozen !== true);
    if (indices.length) return { indices, end };
    start = end;
  }
  return null;
}

export function activeStepIndices(run: WorkflowRun): number[] {
  return run.activeStepIndices ?? [run.currentStepIndex];
}

export function isWorkflowStepActive(run: WorkflowRun, index: number): boolean {
  return run.status === 'running' && activeStepIndices(run).includes(index)
    && !['completed', 'skipped', 'errored', 'cancelled'].includes(run.stepStates?.[index]?.phase ?? 'running');
}

export function stepPhase(run: WorkflowRun, index: number): WorkflowRun['stepPhase'] {
  const phase = run.stepStates?.[index]?.phase ?? run.stepPhase;
  return phase === 'pending' || phase === 'spawning' || phase === 'running' || phase === 'completing' ? phase : undefined;
}

export function setStepPhase(run: WorkflowRun, index: number, phase: WorkflowStepExecution['phase']): void {
  if (run.stepStates?.[index]) run.stepStates[index].phase = phase;
  if (run.currentStepIndex === index && ['pending', 'spawning', 'running', 'completing'].includes(phase)) {
    run.stepPhase = phase as WorkflowRun['stepPhase'];
  }
}

export function stepSessionId(run: WorkflowRun, index: number): string | undefined {
  return run.stepStates?.[index]?.sessionId ?? (index === run.currentStepIndex ? run.stepSessionId : undefined);
}

export function heldStepStop(run: WorkflowRun, index: number): WorkflowRun['stopReceived'] {
  return run.stepStates?.[index]?.stopReceived ?? (run.stopReceived?.stepIndex === index ? run.stopReceived : undefined);
}

export function openStepGroup(run: WorkflowRun, steps: WorkflowStep[], group: { indices: number[]; end: number }): void {
  run.stepStates ??= Object.fromEntries(steps.map((step, index) => [index, {
    stepId: step.id, phase: step.frozen ? 'skipped' : index < group.indices[0] ? 'completed' : 'pending',
  }]));
  run.activeStepIndices = [...group.indices];
  run.groupEndIndex = group.end;
  run.currentStepIndex = group.indices[0];
  run.stepPhase = 'pending';
  delete run.stepSessionId;
  delete run.stopReceived;
}
