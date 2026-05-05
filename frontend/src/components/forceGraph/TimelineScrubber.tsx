// Range scrubber for the last N commits + the working tree. Two
// draggable handles; pushing one past the other carries the other
// handle along (so left ≤ right is always true). Ticks are commits;
// the rightmost tick is "WT" — including it in the range surfaces
// uncommitted changes as rings on the graph.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GitCommit } from '../../api';

type Props = {
  commits: GitCommit[];
  // Inclusive indices into the tick array. Tick array length is
  // commits.length + 1 (last tick = working tree).
  left: number;
  right: number;
  onChange: (left: number, right: number) => void;
  hasUncommitted: boolean;
};

type Handle = 'left' | 'right' | null;

function fmtAge(ts: number): string {
  const dt = Date.now() - ts;
  const m = Math.floor(dt / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function TimelineScrubber({
  commits,
  left,
  right,
  onChange,
  hasUncommitted,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Handle>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Tick count = commits + 1 working-tree slot.
  const tickCount = commits.length + 1;
  const lastIdx = Math.max(0, tickCount - 1);

  // Compute the tick index from a clientX position over the track.
  const idxFromClientX = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || tickCount <= 1) return 0;
      const ratio = (clientX - rect.left) / rect.width;
      const raw = Math.round(ratio * (tickCount - 1));
      return Math.max(0, Math.min(lastIdx, raw));
    },
    [lastIdx, tickCount],
  );

  // Pointer-driven drag. The active handle "carries" the other when it
  // would otherwise cross over.
  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const idx = idxFromClientX(e.clientX);
      if (drag === 'left') {
        // If left has passed right, push right along with it.
        if (idx > right) onChange(idx, idx);
        else onChange(idx, right);
      } else {
        if (idx < left) onChange(idx, idx);
        else onChange(left, idx);
      }
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag, idxFromClientX, left, right, onChange]);

  const tickPositions = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < tickCount; i++) {
      out.push(tickCount === 1 ? 50 : (i / (tickCount - 1)) * 100);
    }
    return out;
  }, [tickCount]);

  if (commits.length === 0) {
    return (
      <div className="timeline-scrubber empty" role="status">
        No git history available
      </div>
    );
  }

  const labelFor = (idx: number): string => {
    if (idx === lastIdx) {
      return hasUncommitted ? 'Working tree (uncommitted)' : 'Working tree (clean)';
    }
    const c = commits[idx];
    if (!c) return '';
    return `${c.shortSha} · ${c.subject} · ${fmtAge(c.date)}`;
  };

  const startDrag = (h: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(h);
  };

  // Click on a tick: snap whichever handle is closer to that index.
  const onTrackPointerDown = (e: React.PointerEvent) => {
    if (drag) return;
    const idx = idxFromClientX(e.clientX);
    const distLeft = Math.abs(idx - left);
    const distRight = Math.abs(idx - right);
    if (distLeft <= distRight) {
      if (idx > right) onChange(idx, idx);
      else onChange(idx, right);
      setDrag('left');
    } else {
      if (idx < left) onChange(idx, idx);
      else onChange(left, idx);
      setDrag('right');
    }
  };

  const leftPct = tickPositions[left] ?? 0;
  const rightPct = tickPositions[right] ?? 100;

  return (
    <div className="timeline-scrubber">
      <div className="timeline-scrubber-header">
        <span className="ts-label">
          History: {commits.length} commits
          {hasUncommitted && <span className="ts-dirty"> · dirty WT</span>}
        </span>
        <span className="ts-range">
          <span className="ts-range-chip ts-from">{labelFor(left)}</span>
          <span className="ts-range-arrow">→</span>
          <span className="ts-range-chip ts-to">{labelFor(right)}</span>
        </span>
      </div>
      <div
        className="timeline-scrubber-track"
        ref={trackRef}
        onPointerDown={onTrackPointerDown}
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          if (drag) return;
          setHover(idxFromClientX(e.clientX));
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
          className={`ts-handle ts-handle-left${drag === 'left' ? ' dragging' : ''}`}
          style={{ left: `${leftPct}%` }}
          onPointerDown={startDrag('left')}
          role="slider"
          aria-label="Range start"
          aria-valuemin={0}
          aria-valuemax={lastIdx}
          aria-valuenow={left}
          tabIndex={0}
        />
        <div
          className={`ts-handle ts-handle-right${drag === 'right' ? ' dragging' : ''}`}
          style={{ left: `${rightPct}%` }}
          onPointerDown={startDrag('right')}
          role="slider"
          aria-label="Range end"
          aria-valuemin={0}
          aria-valuemax={lastIdx}
          aria-valuenow={right}
          tabIndex={0}
        />
        {hover !== null && drag === null && (
          <div
            className="ts-hover-tip"
            style={{ left: `${tickPositions[hover] ?? 0}%` }}
          >
            {labelFor(hover)}
          </div>
        )}
      </div>
    </div>
  );
}
