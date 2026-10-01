import { AlertCircle, Check, Clock3, ShieldCheck, Snowflake, Square } from 'lucide-react';
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
  queued: 'Queued or preparing — waiting to start',
  cancelled: 'Stopped',
  error: 'Failed here',
  skipped: 'Frozen — skipped by this run',
};

// The `#N` badge, which becomes the per-step status indicator during a run: a
// spinner while running, a check when done, an alert glyph on the failed step,
// a snowflake on a frozen (skipped) step, and the dimmed number otherwise.
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
      ) : runStatus === 'skipped' ? (
        <Snowflake size={13} aria-hidden />
      ) : runStatus === 'queued' ? (
        <Clock3 size={13} aria-hidden />
      ) : runStatus === 'cancelled' ? (
        <Square size={11} aria-hidden />
      ) : (
        `#${index + 1}`
      )}
    </span>
  );
}

// The freeze toggle every step kind carries: a snowflake that latches blue when
// the step is frozen, i.e. kept in the workflow but skipped when it runs.
// Shared so the agent header and the compact control row can't drift.
export function StepFreezeButton({
  frozen,
  onToggle,
}: {
  frozen: boolean;
  onToggle: () => void;
}) {
  const label = frozen ? 'Unfreeze step (run it again)' : 'Freeze step (skip it when running)';
  return (
    <button
      className={`icon-btn sm workflows-step-freeze${frozen ? ' frozen' : ''}`}
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={frozen}
    >
      <Snowflake size={12} />
    </button>
  );
}

// Read-only marker on an AGENT step whose `tools` include `opengrep` — i.e. a
// step added from the "Opengrep" quick-add chip or template. Before that
// step's harness spawns the backend scans the project and drops
// OPENGREP_FINDINGS.md beside the brief. Deliberately NOT a toggle: the scan
// belongs to the Opengrep step, not to arbitrary steps (a per-step switch was
// tried and removed at the user's request, 2026-09-21).
export function StepOpengrepBadge({ on }: { on: boolean }) {
  if (!on) return null;
  const label =
    'Opengrep step: Lattice scans the project before this step and hands the agent the findings digest';
  return (
    <span
      className="workflows-step-tool on"
      title={label}
      aria-label={label}
      role="img"
      data-tool="opengrep"
    >
      <ShieldCheck size={12} />
    </span>
  );
}
