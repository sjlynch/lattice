export type TimelineHandle = 'left' | 'right';

export type TimelineRange = {
  left: number;
  right: number;
};

export type TimelineCommitLabelInput = {
  shortSha: string;
  subject: string;
  date: number;
};

export type TrackBounds = {
  left: number;
  width: number;
};

export function fmtAge(ts: number, now = Date.now()): string {
  const dt = now - ts;
  const m = Math.floor(dt / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function lastTickIndex(tickCount: number): number {
  return Math.max(0, tickCount - 1);
}

export function tickPositionsForCount(tickCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    out.push(tickCount === 1 ? 50 : (i / (tickCount - 1)) * 100);
  }
  return out;
}

export function tickIndexFromClientX(
  clientX: number,
  bounds: TrackBounds,
  tickCount: number,
): number {
  if (tickCount <= 1) return 0;
  const maxIdx = lastTickIndex(tickCount);
  const ratio = (clientX - bounds.left) / bounds.width;
  const raw = Math.round(ratio * (tickCount - 1));
  return Math.max(0, Math.min(maxIdx, raw));
}

export function formatWorkingTreeLabel(hasUncommitted: boolean): string {
  return hasUncommitted ? 'Working tree (uncommitted)' : 'Working tree (clean)';
}

export function formatTimelineTickLabel(
  idx: number,
  commits: readonly TimelineCommitLabelInput[],
  hasUncommitted: boolean,
  now = Date.now(),
): string {
  if (idx === commits.length) {
    return formatWorkingTreeLabel(hasUncommitted);
  }
  const commit = commits[idx];
  if (!commit) return '';
  return `${commit.shortSha} · ${commit.subject} · ${fmtAge(commit.date, now)}`;
}

export type TimelineCommitTooltipInput = TimelineCommitLabelInput & {
  body?: string;
  authorName?: string;
};

// Hover text for a range chip: the chip truncates to one line, so this carries
// the full commit message (subject + body) under a sha · author · age line.
export function formatTimelineTickTooltip(
  idx: number,
  commits: readonly TimelineCommitTooltipInput[],
  hasUncommitted: boolean,
  now = Date.now(),
): string {
  if (idx === commits.length) {
    return formatWorkingTreeLabel(hasUncommitted);
  }
  const commit = commits[idx];
  if (!commit) return '';
  const meta = [commit.shortSha, commit.authorName, fmtAge(commit.date, now)]
    .filter(Boolean)
    .join(' · ');
  const message = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
  return `${meta}\n\n${message}`;
}

// After a background git-history refresh (a commit made / undone, or the tree
// going dirty/clean while the tab is open) the working-tree tick can shift index
// because commits.length changed. Map the user's current [left,right] range onto
// the new tick space so a live update never yanks their scrubber:
//   - the default full range stays full (the common untouched-scrubber case,
//     incl. an empty repo's first commit) — so "watch the WT go clean" works;
//   - a right handle parked on the OLD working-tree slot follows to the NEW one;
//   - otherwise indices are preserved, clamped into the new [0, newWtIdx] range.
// oldWtIdx/newWtIdx are the working-tree tick index = commits.length before and
// after the refresh.
export function reconcileTimelineRange(
  range: TimelineRange,
  oldWtIdx: number,
  newWtIdx: number,
): TimelineRange {
  const wt = Math.max(0, newWtIdx);
  if (range.left === 0 && range.right === oldWtIdx) {
    return { left: 0, right: wt };
  }
  const right = range.right === oldWtIdx ? wt : Math.min(range.right, wt);
  const left = Math.min(Math.max(0, range.left), right);
  return { left, right };
}

export function rangeForHandleMove(
  handle: TimelineHandle,
  idx: number,
  left: number,
  right: number,
): TimelineRange {
  if (handle === 'left') {
    return idx > right ? { left: idx, right: idx } : { left: idx, right };
  }
  return idx < left ? { left: idx, right: idx } : { left, right: idx };
}

export function nearestHandleForIndex(
  idx: number,
  left: number,
  right: number,
): TimelineHandle {
  const distLeft = Math.abs(idx - left);
  const distRight = Math.abs(idx - right);
  return distLeft <= distRight ? 'left' : 'right';
}

export function rangeForTrackSelection(
  idx: number,
  left: number,
  right: number,
): { handle: TimelineHandle; range: TimelineRange } {
  const handle = nearestHandleForIndex(idx, left, right);
  return { handle, range: rangeForHandleMove(handle, idx, left, right) };
}
