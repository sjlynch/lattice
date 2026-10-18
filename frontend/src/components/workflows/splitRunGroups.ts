import type { WorkflowRun } from '../../api';
import { combinedStepStatus, stepRunStatus, type StepRunStatus } from './stepRunStatus';
type Member = { id: string; label: string; status: StepRunStatus };
export type RunStepRow = { id: string; title: string; status: StepRunStatus; members: Member[] };
export function groupRunSteps(run: WorkflowRun): RunStepRow[] {
  const rows: RunStepRow[] = [];
  for (const [i, step] of (run.definition?.steps ?? []).entries()) {
    const status = stepRunStatus(i, run, step.frozen, step.id) ?? 'pending';
    if (!step.splitOf) { rows.push({ id: step.id, title: step.title, status, members: [] }); continue; }
    let row = rows.find((r) => r.id === step.splitOf);
    if (!row) {
      const suffix = ` · ${step.splitArea?.label ?? ''}`;
      row = { id: step.splitOf, title: step.title.endsWith(suffix) ? step.title.slice(0, -suffix.length) : step.title, status, members: [] };
      rows.push(row);
    }
    row.members.push({ id: step.id, label: step.splitArea?.label ?? step.title, status });
    row.status = combinedStepStatus(row.members.map((m) => m.status));
  }
  return rows;
}
