// Manages the lifecycle of the terminal server (a separate process on port
// 5185) and proxies terminal WebSocket connections to it.
//
// Design rationale: PTY sessions are owned by terminal-server.ts, which runs
// detached from the main server. When the main server restarts (e.g. during
// development), the terminal server keeps running and all Claude agents inside
// it continue uninterrupted. The main server reconnects on next startup.

import {
  proxyKillSession as rawProxyKillSession,
  proxyKillSessionsByCwd as rawProxyKillSessionsByCwd,
} from './terminalServerClient.js';
import { terminalRegistry } from './terminalRegistry/store.js';
import { normalizeCwd } from './terminalRegistry/harnessPaths.js';

export { ensureTerminalServer } from './terminalServerLifecycle.js';
export {
  proxyCountSessions,
  proxyCreateSession,
  proxyListSessions,
  proxyListSessionsOrNull,
  proxyShutdown,
} from './terminalServerClient.js';
export { proxyTerminalWs } from './terminalWsRelay.js';

// The kill paths also end the durable registry records for the ptys they
// destroy, so a tab Lattice itself tore down (worktree cleanup, run cancel,
// task completion) is never relaunched by restore. Registry bookkeeping is
// best-effort and never blocks or fails the kill.
export async function proxyKillSession(id: string): Promise<boolean> {
  await terminalRegistry
    .endWhere((r) => r.serverId === id, { reason: 'killed' })
    .catch(() => 0);
  return rawProxyKillSession(id);
}

export async function proxyKillSessionsByCwd(worktreePath: string): Promise<void> {
  const root = normalizeCwd(worktreePath);
  await terminalRegistry
    .endWhere((r) => {
      const cwd = normalizeCwd(r.cwd);
      return cwd === root || cwd.startsWith(`${root}/`);
    }, { reason: 'owner-finished' })
    .catch(() => 0);
  return rawProxyKillSessionsByCwd(worktreePath);
}
