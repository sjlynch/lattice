// Range scrubber for the last N commits + the working tree. Two
// draggable handles; pushing one past the other carries the other
// handle along (so left ≤ right is always true). Ticks are commits;
// the rightmost tick is "WT" — including it in the range surfaces
// uncommitted changes as rings on the graph.

import { memo, useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { GitCommit } from '../../api';
import { CommitTooltip } from './CommitTooltip';
import {
  formatTimelineTickLabel,
  formatTimelineTickTooltip,
  lastTickIndex,
  tickPositionsForCount,
} from './timelineRange';
import { useTimelineScrubberDrag } from './useTimelineScrubberDrag';

type Props = {
  commits: GitCommit[];
  // Inclusive indices into the tick array. Tick array length is
  // commits.length + 1 (last tick = working tree).
  left: number;
  right: number;
  onChange: (left: number, right: number) => void;
  hasUncommitted: boolean;
};

export const TimelineScrubber = memo(function TimelineScrubber({
  commits,
  left,
  right,
  onChange,
  hasUncommitted,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Range chip under the pointer, anchored at its top-center (viewport coords).
  const [chipTip, setChipTip] = useState<{ chip: 'from' | 'to'; x: number; top: number } | null>(null);

  // Tick count = commits + 1 working-tree slot.
  const tickCount = commits.length + 1;
  const lastIdx = lastTickIndex(tickCount);
  const {
    activeHandle,
    indexFromClientX,
    startHandleDrag,
    onTrackPointerDown,
  } = useTimelineScrubberDrag(trackRef, left, right, tickCount, onChange);

  const tickPositions = useMemo(
    () => tickPositionsForCount(tickCount),
    [tickCount],
  );
  const labelFor = useCallback(
    (idx: number): string => formatTimelineTickLabel(idx, commits, hasUncommitted),
    [commits, hasUncommitted],
  );
  const tooltipFor = useCallback(
    (idx: number): string => formatTimelineTickTooltip(idx, commits, hasUncommitted),
    [commits, hasUncommitted],
  );

  if (commits.length === 0) {
    // A repo with no commits yet (a freshly created project whose first
    // commit never landed) has nothing to scrub, but is not "no git".
    return (
      <div className="timeline-scrubber empty" role="status">
        {hasUncommitted
          ? 'No commits yet — the working tree has uncommitted changes'
          : 'No git history available'}
      </div>
    );
  }

  const leftPct = tickPositions[left] ?? 0;
  const rightPct = tickPositions[right] ?? 100;

  const chipHoverProps = (chip: 'from' | 'to') => ({
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      setChipTip({ chip, x: r.left + r.width / 2, top: r.top });
    },
    onMouseLeave: () => setChipTip(null),
    'aria-label': tooltipFor(chip === 'from' ? left : right),
  });

  let trackTip: { x: number; top: number } | null = null;
  if (hover !== null && activeHandle === null && trackRef.current) {
    const r = trackRef.current.getBoundingClientRect();
    trackTip = { x: r.left + ((tickPositions[hover] ?? 0) / 100) * r.width, top: r.top };
  }

  return (
    <div className="timeline-scrubber">
      <div className="timeline-scrubber-header">
        <span className="ts-label">
          History: {commits.length} commits
          {hasUncommitted && <span className="ts-dirty"> · dirty WT</span>}
        </span>
        <span className="ts-range">
          <span className="ts-range-chip ts-from" {...chipHoverProps('from')}>
            {labelFor(left)}
          </span>
          <span className="ts-range-arrow">→</span>
          <span className="ts-range-chip ts-to" {...chipHoverProps('to')}>
            {labelFor(right)}
          </span>
        </span>
      </div>
      <div
        className="timeline-scrubber-track"
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          if (activeHandle) return;
          setHover(indexFromClientX(e.clientX));
        }}
      >
        <div
          className="ts-track-fill"
          style={{ left: `${leftPct}%`, width: `${Math.max(0, rightPct - leftPct)}%` }}
        />
        {tickPositions.map((pct, i) => {
          const inRange = i >= left && i <= right;
          const isWT = i === lastIdx;
          return (
            <div
              key={i}
              className={`ts-tick${inRange ? ' in-range' : ''}${isWT ? ' wt' : ''}`}
              style={{ left: `${pct}%` }}
            >
              <div className="ts-tick-mark" />
            </div>
          );
        })}
        <div
          className={`ts-handle ts-handle-left${activeHandle === 'left' ? ' dragging' : ''}`}
          style={{ left: `${leftPct}%` }}
          onPointerDown={startHandleDrag('left')}
          role="slider"
          aria-label="Range start"
          aria-valuemin={0}
          aria-valuemax={lastIdx}
          aria-valuenow={left}
          tabIndex={0}
        />
        <div
          className={`ts-handle ts-handle-right${activeHandle === 'right' ? ' dragging' : ''}`}
          style={{ left: `${rightPct}%` }}
          onPointerDown={startHandleDrag('right')}
          role="slider"
          aria-label="Range end"
          aria-valuemin={0}
          aria-valuemax={lastIdx}
          aria-valuenow={right}
          tabIndex={0}
        />
        {hover !== null && trackTip && (
          <CommitTooltip x={trackTip.x} top={trackTip.top} text={tooltipFor(hover)} />
        )}
      </div>
      {chipTip && (
        <CommitTooltip x={chipTip.x} top={chipTip.top} text={tooltipFor(chipTip.chip === 'from' ? left : right)} />
      )}
    </div>
  );
});
