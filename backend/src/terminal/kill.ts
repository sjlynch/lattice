import { ensureClaudeConfigValid } from '../claudeConfigGuard.js';
import { killProcessTreeWindows } from '../processTree.js';
import { allSessions, getSession } from './sessionStore.js';

// Kill all sessions whose cwd is `prefix` or starts with `prefix + sep`.
// Returns the count of sessions killed.
export function killSessionsByCwd(prefix: string): number {
  const norm = prefix.replace(/[\\/]+$/, '').toLowerCase();
  let count = 0;
  for (const session of allSessions()) {
    const sessionNorm = session.cwd.replace(/[\\/]+$/, '').toLowerCase();
    if (sessionNorm === norm || sessionNorm.startsWith(norm + '/') || sessionNorm.startsWith(norm + '\\')) {
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
  // taskkill /F gives Claude no chance to flush ~/.claude.json. After it's
  // landed, validate the file and restore from backup if the kill
  // truncated a write. Without refreshBackup — the file may still be in
  // a pending-flush state we don't want to capture as "known good".
  setTimeout(() => {
    void ensureClaudeConfigValid();
  }, 2000);
  return true;
}
