// Pure presentation logic for the Git Setup feature: the navbar chip's state,
// the copy shown when a folder can't be initialized, and the number formatting
// the preview dialog uses. No React, no fetch — this is the unit-tested core
// (`src/__tests__/gitSetupDerive.test.ts`) that the components render.

import type { ProjectGitProbe } from '../../api/types/git';

// What the navbar's git slot should render. `null` = render nothing at all,
// which is the pre-feature behaviour and the right answer for "no folder open"
// and "we don't know yet".
export type GitChipState =
  | { kind: 'branch'; label: string; title: string }
  // Clickable — the only state that opens the setup dialog.
  | { kind: 'action'; label: string; title: string }
  | { kind: 'info'; label: string; title: string; tone: 'muted' | 'warning' };

// A verb, not a status: "No Git" is a dead end, "Set up Git" is an invitation.
const SET_UP_LABEL = 'Set up Git';
const NO_GIT_LABEL = 'No Git';

/** Last path segment, tolerant of either separator and of trailing slashes. */
export function basename(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function defaultReason(probe: ProjectGitProbe): string {
  switch (probe.state) {
    case 'unavailable':
      return 'The git command-line tool was not found on your PATH.';
    case 'bare':
      return 'This folder is a bare git repository, so it has no working tree.';
    case 'nested':
      return 'This folder sits inside another git repository.';
    case 'none':
      return 'Git cannot be initialized in this folder.';
    default:
      return 'Lattice could not determine this folder\'s git status.';
  }
}

// The backend's `reason` is authoritative when present; ours is the fallback so
// a chip tooltip is never empty.
function reasonOf(probe: ProjectGitProbe): string {
  return probe.reason?.trim() || defaultReason(probe);
}

export function deriveGitChipState(
  probe: ProjectGitProbe | null | undefined,
  branch: string | null,
): GitChipState | null {
  // No probe: still loading, the fetch failed, or a backend that predates the
  // Git-setup contract. Degrade to exactly what the navbar did before — the
  // branch chip if we have one, otherwise nothing. Never guess "No Git".
  if (!probe) return branch ? branchChip(branch) : null;

  switch (probe.state) {
    case 'repo':
      return branch ? branchChip(branch) : null;
    case 'nested': {
      const parent = probe.toplevel ? basename(probe.toplevel) : '';
      const where = probe.toplevel ? ` at ${probe.toplevel}` : '';
      return {
        kind: 'info',
        tone: 'warning',
        label: parent ? `inside ${parent}` : 'inside a repo',
        // Say what Lattice will DO, not just what it found: worktrees, branches
        // and merges all land in the ancestor repo, which is rarely what
        // someone who opened this subfolder expects.
        title: `${reasonOf(probe)} Lattice will use the parent repository${where}.`,
      };
    }
    case 'none':
      if (probe.initable) {
        return {
          kind: 'action',
          label: SET_UP_LABEL,
          title:
            'This folder is not a git repository yet. Click to set one up so Lattice can run tasks in worktrees.',
        };
      }
      return { kind: 'info', tone: 'muted', label: NO_GIT_LABEL, title: reasonOf(probe) };
    default:
      return { kind: 'info', tone: 'muted', label: NO_GIT_LABEL, title: reasonOf(probe) };
  }
}

function branchChip(branch: string): GitChipState {
  return { kind: 'branch', label: branch, title: `Current git branch: ${branch}` };
}

export type ProbeBlocker = { title: string; lines: string[] };

// Copy for the "we can't set Git up here" dialog — every probe state except
// the one that opens the real setup flow (`none` + `initable`).
export function describeProbeBlocker(probe: ProjectGitProbe): ProbeBlocker {
  switch (probe.state) {
    case 'repo':
      return {
        title: 'This folder is already a git repository',
        lines: ['Nothing to set up — Lattice can run tasks here as-is.'],
      };
    case 'nested':
      return {
        title: 'This folder is already inside a git repository',
        lines: [
          reasonOf(probe),
          probe.toplevel
            ? `Lattice will use the parent repository at ${probe.toplevel} — its worktrees, branches and merges all live there.`
            : 'Lattice will use the parent repository for worktrees, branches and merges.',
          // Initializing here would create a repo the parent sees as a gitlink.
          // That is the single worst outcome this feature can produce, so it is
          // never offered — not even behind a confirmation.
          'Creating a second repository here would nest it inside that one, so Lattice does not offer it.',
        ],
      };
    case 'unavailable':
      return {
        title: 'Git is not available',
        lines: [
          reasonOf(probe),
          'Install git and make sure it is on your PATH, then reopen this project.',
        ],
      };
    default:
      return { title: 'Git cannot be set up here', lines: [reasonOf(probe)] };
  }
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole bytes, one decimal above that: the point is "is this a sane first
  // commit or a 2GB node_modules", not an exact figure.
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

// `truncated` means the backend's walk hit its cap, so the number is a floor —
// render it as "20,000+" rather than implying everything was counted.
export function formatFileCount(count: number, truncated: boolean): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  return `${safe.toLocaleString('en-US')}${truncated ? '+' : ''}`;
}

// The `largest` list is noise for an ordinary source tree; it earns its space
// only when something in it is big enough to be a mistake.
export const LARGE_ENTRY_BYTES = 1024 * 1024;

export function hasLargeEntry(entries: { bytes: number }[]): boolean {
  return entries.some((e) => e.bytes >= LARGE_ENTRY_BYTES);
}
