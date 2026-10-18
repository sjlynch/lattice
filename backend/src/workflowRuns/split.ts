import type { Workflow, WorkflowStep } from '../workflows/types.js';
import { collectAreaSourceFiles } from '../sourceAreasCollect.js';
import { partitionSourceAreas, resolveCustomAreas, renderAreaScope } from '../shared/sourceAreas.js';
import { cloneWorkflowDefinition } from './definition.js';

// Called only on a new start. Recovery consumes the frozen definition as-is.
export async function expandWorkflowSplits(workflow: Workflow, collect = collectAreaSourceFiles): Promise<{ definition: Workflow; notes: string[] }> {
  const definition = cloneWorkflowDefinition(workflow), notes: string[] = [];
  if (!definition.steps.some((s) => (s.kind ?? 'agent') === 'agent' && s.split)) return { definition, notes };
  let source: Awaited<ReturnType<typeof collect>>;
  try { source = await collect(workflow.projectPath); }
  catch (err) {
    definition.steps = definition.steps.map((s) => {
      if (!s.split) return s;
      notes.push(`${s.title}: could not resolve split; running one step (${(err as Error).message}).`);
      const { split: _, ...parent } = s; return parent;
    });
    return { definition, notes };
  }
  definition.steps = definition.steps.flatMap((step): WorkflowStep[] => {
    if ((step.kind ?? 'agent') !== 'agent' || !step.split) return [step];
    const { split, ...parent } = step;
    try {
      const areas = split.mode === 'auto' ? partitionSourceAreas(source.files, split.count ?? 10, { packageRoots: source.packageRoots })
        : resolveCustomAreas(source.files, split.areas ?? [], split.includeRest !== false).areas;
      if (areas.length < 2) { notes.push(`${step.title}: split resolved to ${areas.length} area(s); running one step.`); return [parent]; }
      return areas.map((area, k) => ({ ...parent, id: `${step.id}__area${k + 1}`, title: `${step.title} · ${area.label}`,
        prompt: `${renderAreaScope(area)}\n\n---\n\n${step.prompt}`, parallel: true,
        splitOf: step.id, splitArea: { label: area.label, paths: [...area.paths], files: area.files },
        splitGroup: step.parallel ? undefined : step.id }));
    } catch (err) {
      notes.push(`${step.title}: could not resolve split; running one step (${(err as Error).message}).`);
      return [parent];
    }
  });
  return { definition, notes };
}
