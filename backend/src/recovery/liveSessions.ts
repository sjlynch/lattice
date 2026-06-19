// Shared "is a PTY still live for this cwd?" plumbing for the recovery sweeps.
//
// The terminal-server is detached + unref'd and reused across backend restarts
// (see terminalServerLifecycle.ts), so it — not the in-memory run registries —
// is the source of truth for which sessions are still alive. The in_progress
// sweep, the QA orphan sweep, and the push orphan sweep all need the same
// question answered ("does a live session's cwd sit at or under this dir?"), so
// the helper lives here once.

import path from 'node:path';
import { proxyListSessionsOrNull } from '../terminalProxy.js';

// Path normalization for cwd comparison: case-insensitive on Windows (the
// filesystem is case-preserving, not case-sensitive), separators resolved,
// trailing slash stripped.
export function normalizeCwd(p: string): string {
  let out = path.resolve(p);
  if (process.platform === 'win32') out = out.toLowerCase();
  return out.replace(/[\\/]+$/, '');
}

// Returns the resolved cwd of every live terminal-server session, or null when
// the terminal-server is unreachable (so callers can distinguish "no sessions"
// from "can't tell" — same distinction the spawn queue makes).
export async function collectLiveSessionCwds(): Promise<Set<string> | null> {
  // proxyListSessionsOrNull returns null when the terminal-server is
  // unreachable/unparseable (vs [] for a genuine empty list), so a transient
  // fetch failure can't masquerade as "no live sessions" and trick a sweep
  // into reclaiming a still-live session's dir.
  const sessions = await proxyListSessionsOrNull();
  if (sessions === null) return null;
  const set = new Set<string>();
  for (const s of sessions) {
    if (s && typeof s === 'object' && 'cwd' in s) {
      const cwd = (s as { cwd?: unknown }).cwd;
      if (typeof cwd === 'string' && cwd.length > 0) {
        set.add(normalizeCwd(cwd));
      }
    }
  }
  return set;
}

// True if any live session's cwd is `dir` itself or nested under it. Mirrors the
// equal-or-under predicate killSessionsByCwd uses (terminal/kill.ts), so a sweep
// skips exactly the sessions a cleanup would otherwise kill.
export function hasLiveSessionAtOrUnder(liveCwds: Set<string>, dir: string): boolean {
  const norm = normalizeCwd(dir);
  for (const cwd of liveCwds) {
    if (cwd === norm || cwd.startsWith(norm + '/') || cwd.startsWith(norm + '\\')) {
      return true;
    }
  }
  return false;
}
