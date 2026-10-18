import type { SourceArea, WorkflowStep } from '../../api';
import { renderAreaScope } from '../../../../backend/src/shared/sourceAreas';

// The caller allocates a fresh id prefix before updating state, keeping this
// transformation deterministic and preserving every other authored field.
export function splitStep(step: WorkflowStep, areas: readonly SourceArea[], idPrefix: string): WorkflowStep[] {
  return areas.map((area, index) => ({
    ...step,
    id: `${idPrefix}_${index}`,
    title: `${step.title} · ${area.label}`,
    prompt: `${renderAreaScope(area)}\n\n---\n\n${step.prompt}`,
    parallel: true,
  }));
}
