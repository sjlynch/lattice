import { useMemo } from 'react';
import type { WorkflowRun } from '../../../api';
import type { ControlProgress } from './useWorkflowRuns';

type Args = {
  activeRuns: Record<string, WorkflowRun>;
  recentRuns: Record<string, WorkflowRun>;
  controlProgress: Record<string, ControlProgress>;
  // The workflow currently loaded in the editor, or null for an unsaved draft.
  editorWorkflowId: string | null;
};

export type WorkflowRunViews = {
  activeRunList: WorkflowRun[];
  recentFailedRunList: WorkflowRun[];
  runForEditor: WorkflowRun | undefined;
  controlProgressForEditor: ControlProgress | undefined;
  recentForEditor: WorkflowRun | undefined;
};

// Derived run views for the manager: the sorted active-run list, the
// recently-failed list surfaced as a navbar chip + runs-aside section, and the
// active/recent/control-progress run that belongs to the currently-edited
// workflow (so the editor head strip reflects the right run). Split out of
// useWorkflowManager so the composer reads as plain wiring.
export function useWorkflowRunViews({
  activeRuns,
  recentRuns,
  controlProgress,
  editorWorkflowId,
}: Args): WorkflowRunViews {
  const activeRunList = useMemo(
    () => Object.values(activeRuns).sort((a, b) => a.startedAt - b.startedAt),
    [activeRuns],
  );

  // Recently-finished runs that ended in failure (errored or cancelled). These
  // linger ~5min in `recentRuns` (vs ~10s for completed) so the user has a
  // chance to spot a failure they otherwise wouldn't have seen — see
  // `useWorkflowRuns` for the linger policy. Surfaced as a small navbar chip
  // and a section in the runs aside.
  const recentFailedRunList = useMemo(
    () =>
      Object.values(recentRuns)
        .filter((r) => r.status === 'errored' || r.status === 'cancelled')
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)),
    [recentRuns],
  );

  // Find any active/recent run for the currently-edited workflow so the strip
  // in the editor head reflects the right run. Memoized so the scan only reruns
  // when the run maps or the edited workflow change.
  const runForEditor = useMemo(
    () =>
      editorWorkflowId
        ? Object.values(activeRuns).find((r) => r.workflowId === editorWorkflowId)
        : undefined,
    [activeRuns, editorWorkflowId],
  );
  const controlProgressForEditor = runForEditor
    ? controlProgress[runForEditor.id]
    : undefined;
  const recentForEditor = useMemo(
    () =>
      editorWorkflowId
        ? Object.values(recentRuns).find((r) => r.workflowId === editorWorkflowId)
        : undefined,
    [recentRuns, editorWorkflowId],
  );

  return {
    activeRunList,
    recentFailedRunList,
    runForEditor,
    controlProgressForEditor,
    recentForEditor,
  };
}
