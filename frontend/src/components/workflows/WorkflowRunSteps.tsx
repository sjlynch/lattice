import type { WorkflowRun } from '../../api';
import { groupRunSteps } from './splitRunGroups';
import type { StepRunStatus } from './stepRunStatus';
const labels: Record<StepRunStatus, string> = { running: 'Running', done: 'Completed', error: 'Failed', pending: 'Pending', queued: 'Preparing', cancelled: 'Stopped', skipped: 'Skipped' };
export function WorkflowRunSteps({ run }: { run: WorkflowRun }) {
  const rows = groupRunSteps(run);
  if (!rows.some((r) => r.members.length)) return null;
  return <div className="workflows-run-steps" aria-label="Run steps">
    {rows.map((row) => row.members.length ? <details key={row.id}>
      <summary>{row.title} · {row.members.length} areas ? {labels[row.status]}</summary>
      <ul>{row.members.map((m) => <li key={m.id}>{m.label} · {labels[m.status]}</li>)}</ul>
    </details> : <div key={row.id}>{row.title} · {labels[row.status]}</div>)}
  </div>;
}
