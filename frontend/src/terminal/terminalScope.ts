import type { TerminalSpec } from './terminalTypes';

// Per-project scoping predicate for the sidebar terminal list. Kept pure (and
// separate from the list-mutation ops in terminalState.ts) so the grouping
// filter in ../components/sidebar/hooks/useTerminalGroups.ts and its tests can
// share one source of truth.

// Normalize a directory path for a coarse, cross-platform comparison:
// backslashes → forward slashes, drop a trailing slash, lowercase. Windows
// paths are case-insensitive; a Lattice active-folder and a terminal cwd come
// from the same backend/UI source so this is safe for scoping on POSIX too.
export function normalizeDirPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Is `child` the same directory as, or nested inside, `parent`? Uses a
// segment-boundary check so `/foo/bar-baz` is NOT treated as inside `/foo/bar`.
export function isPathWithin(child: string, parent: string): boolean {
  const c = normalizeDirPath(child);
  const p = normalizeDirPath(parent);
  if (!p) return false;
  return c === p || c.startsWith(`${p}/`);
}

// Does a terminal belong to the given active project folder?
//
//  - A terminal that recorded its `projectPath` (every terminal spawned since
//    the field was added) is scoped strictly to that project.
//  - A LEGACY terminal persisted before `projectPath` existed (so it's missing)
//    is inferred from its `cwd`: it belongs only when its cwd equals or descends
//    from the active folder. This replaces the old `!projectPath` catch-all that
//    listed — and let auto-selection pick — a legacy terminal whose cwd points
//    at project A while the UI was showing project B (a wrong-repo shell).
export function terminalBelongsToProject(
  t: TerminalSpec,
  activeFolder: string,
): boolean {
  // Normalized, not `===`: a registry record's `projectPath` is stamped by the
  // backend from `realpathSync.native` (its own casing / separators), while
  // `activeFolder` only has its drive letter canonicalized (`projectPath.ts`).
  // A strict compare listed NO registry tabs for a folder that differed only
  // by directory casing or `\` vs `/`.
  if (t.projectPath) return normalizeDirPath(t.projectPath) === normalizeDirPath(activeFolder);
  return isPathWithin(t.cwd, activeFolder);
}
