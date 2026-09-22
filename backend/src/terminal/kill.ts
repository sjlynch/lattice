import { ensureClaudeConfigValid } from '../claudeConfigGuard.js';
import { killProcessTreeWindows } from '../processTree.js';
import { allSessions, getSession } from './sessionStore.js';

// Separator-agnostic (a `C:/x/wt` prefix must match a `C:\x\wt\sub` session —
// the backend's liveness checks, mergeRuns/waiterLiveness.ts and
// recovery/liveSessions.ts, already compare this way, so a mismatch here meant
// "a live pty is under the worktree" yet the kill found nothing and the pty
// kept its Windows file locks), case-folded only where paths are
// case-insensitive.
function normCwd(p: string, platform: NodeJS.Platform): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

// `cwd` is `prefix` itself or nested under it.
export function cwdIsAtOrUnder(
  cwd: string,
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const base = normCwd(prefix, platform);
  const norm = normCwd(cwd, platform);
  return norm === base || norm.startsWith(base + '/');
}

// Kill all sessions whose cwd is `prefix` or nested under it.
// Returns the count of sessions killed.
export function killSessionsByCwd(prefix: string): number {
  let count = 0;
  for (const session of allSessions()) {
    if (cwdIsAtOrUnder(session.cwd, prefix)) {
      killSession(session.id);
      count += 1;
    }
  }
  return count;
}

export function killSession(id: string): boolean {
  const session = getSession(id);
  if (!session) {
    console.warn(`[terminal] killSession: no session with id ${id}`);
    return false;
  }
  if (session.killing) {
    console.log(`[terminal] killSession: ${id} already killing, no-op`);
    return true;
  }
  session.killing = true;
  const pid = session.pty.pid;
  console.log(
    `[terminal] killing session ${id} (cwd=${session.cwd}, pid=${pid}, subscribers=${session.subscribers.size})`,
  );
  try {
    session.pty.kill();
  } catch (err) {
    console.warn(`[terminal] pty.kill threw for ${id}:`, err);
  }
  // Belt-and-braces: pty.kill closes the conpty but doesn't reach
  // grandchildren (claude/node spawned by powershell). Force-kill the whole
  // process tree on Windows so they don't accumulate as orphans.
  killProcessTreeWindows(pid);
  schedulePostKillConfigCheck();
  return true;
}

// taskkill /F gives Claude no chance to flush ~/.claude.json. After it's
// landed, validate the file and restore from backup if the kill truncated a
// write. Without refreshBackup — the file may still be in a pending-flush
// state we don't want to capture as "known good".
//
// Debounced: a kill-by-cwd / run cancel / shutdown kills N sessions in one
// burst, and each check is a synchronous read + JSON.parse of a file that can
// be hundreds of KB, on the event loop every pty shares. One check
// POST_KILL_CHECK_DELAY_MS after the LAST kill of a burst covers every kill in
// it (each taskkill has had at least that long to land).
export const POST_KILL_CHECK_DELAY_MS = 2000;
let postKillCheck: ReturnType<typeof setTimeout> | null = null;

export function schedulePostKillConfigCheck(
  check: () => Promise<void> = ensureClaudeConfigValid,
): void {
  if (postKillCheck) clearTimeout(postKillCheck);
  postKillCheck = setTimeout(() => {
    postKillCheck = null;
    void check().catch(() => { /* best-effort backstop */ });
  }, POST_KILL_CHECK_DELAY_MS);
  // Never hold the process open just for this backstop.
  postKillCheck.unref();
}
