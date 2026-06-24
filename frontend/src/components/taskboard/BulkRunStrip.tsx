import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { Lane as LaneDef } from './lanes';
import type {
  BulkStripLane,
  BulkStripView,
} from './hooks/useBulkRunStrips';

// Per-kind copy. Reuses the merge-run strip CSS so the Open / In Progress / QA
// bulk actions get the same look as the Ready-to-Merge run strip.
const COPY: Record<
  BulkStripView['kind'],
  { gerund: string; past: string; spawnedLabel: string }
> = {
  run: { gerund: 'Starting', past: 'Started', spawnedLabel: 'spawned' },
  resume: { gerund: 'Resuming', past: 'Resumed', spawnedLabel: 'spawned' },
  'qa-done': { gerund: 'Marking', past: 'Marked', spawnedLabel: 'done' },
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Renders the bulk strip above the Open / In Progress / QA lanes only. Mirrors
// mergeRunStripFor's call shape so the launcher can `?? ` the two together.
export function bulkRunStripFor(
  lane: LaneDef,
  bulkStrips: Partial<Record<BulkStripLane, BulkStripView>>,
  onDismiss: (lane: BulkStripLane) => void,
): ReactNode | undefined {
  if (lane.id !== 'open' && lane.id !== 'in_progress' && lane.id !== 'qa') {
    return undefined;
  }
  const view = bulkStrips[lane.id];
  if (!view) return undefined;
  const bulkLane = lane.id;
  return <BulkRunStrip view={view} onDismiss={() => onDismiss(bulkLane)} />;
}

// Lightweight progress strip for a lane-level bulk action. Active phase shows a
// spinner + live "(X spawned, Y queued)" counts; the done phase is a short
// dismissable success line that auto-clears (timer lives in the hook).
function BulkRunStrip({
  view,
  onDismiss,
}: {
  view: BulkStripView;
  onDismiss: () => void;
}) {
  const copy = COPY[view.kind];

  if (view.phase === 'active') {
    const head =
      view.kind === 'qa-done'
        ? `Marking ${plural(view.total, 'task')} done`
        : `${copy.gerund} ${plural(view.total, 'task')}`;
    const showCounts = view.spawned > 0 || view.queued > 0;
    return (
      <div className="merge-run-strip running" role="status">
        <span className="merge-run-strip-spinner" />
        <span className="merge-run-strip-text">
          {head}…
          {showCounts && (
            <>
              {' '}·{' '}
              <span className="merge-run-stat ok">
                {view.spawned} {copy.spawnedLabel}
              </span>
              {view.queued > 0 && (
                <>
                  {' '}·{' '}
                  <span className="merge-run-stat conflict">
                    {view.queued} queued
                  </span>
                </>
              )}
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="merge-run-strip done" role="status">
      <span className="merge-run-strip-text">
        {summaryHeadline(view)}
        {view.kind === 'run' && view.queued > 0 && (
          <>
            {' '}·{' '}
            <span className="merge-run-stat conflict">{view.queued} queued</span>
          </>
        )}
      </span>
      <button
        className="merge-run-strip-btn"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function summaryHeadline(view: BulkStripView): string {
  const copy = COPY[view.kind];
  if (view.kind === 'qa-done') return `Marked ${plural(view.total, 'task')} done`;
  if (view.kind === 'resume') {
    // Normal completion lands all of them; a safety-timeout finish may be
    // partial, so name the actual count.
    return view.spawned >= view.total
      ? `${copy.past} ${plural(view.total, 'task')}`
      : `${copy.past} ${view.spawned} of ${view.total} tasks`;
  }
  return `${copy.past} ${plural(view.total, 'task')}`;
}
