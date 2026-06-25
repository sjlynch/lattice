import { AlertCircle, Check } from 'lucide-react';
import type { WorkflowStep } from '../../api';
import type { StepRunStatus } from './stepRunStatus';

// Row callback props are id/index-parameterized so the parent can hand down a
// single stable handler per concern (one `useCallback`, not one closure per
// row). Combined with `React.memo` on each row — and on the agent row's header
// and prompt subcomponents — typing in one step only re-renders the piece that
// actually changed: siblings (and the untouched half of the same row) keep
// their memoized output because every prop they receive is referentially
// stable.
export type StepRowCallbacks = {
  onChange: (index: number, patch: Partial<WorkflowStep>) => void;
  onRemove: (index: number) => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
  onToggleCollapse: (stepId: string) => void;
  onCustomize: (index: number) => void;
};

const STEP_RUN_STATUS_TITLE: Record<StepRunStatus, string> = {
  running: 'Running…',
  done: 'Completed',
  pending: 'Pending',
  error: 'Failed here',
};

// The `#N` badge, which becomes the per-step status indicator during a run: a
// spinner while running, a check when done, an alert glyph on the failed step,
// and the dimmed number otherwise.
export function StepIndexBadge({
  index,
  runStatus,
}: {
  index: number;
  runStatus?: StepRunStatus;
}) {
  return (
    <span
      className={`workflows-step-index${runStatus ? ` run-${runStatus}` : ''}`}
      title={runStatus ? STEP_RUN_STATUS_TITLE[runStatus] : undefined}
    >
      {runStatus === 'running' ? (
        <span className="workflows-step-spinner" aria-hidden />
      ) : runStatus === 'done' ? (
        <Check size={13} aria-hidden />
      ) : runStatus === 'error' ? (
        <AlertCircle size={13} aria-hidden />
      ) : (
        `#${index + 1}`
      )}
    </span>
  );
}
