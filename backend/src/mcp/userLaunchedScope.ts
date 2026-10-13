// Which spawns count as USER-launched — the only ones `lattice-control` (the
// multi-instance controller: any project, any instance, workflow runs, a raw
// /api/ hatch) may reach. Decided at the spawn chokepoint
// (`terminalServerClient/spawnBody.ts`) and fail-closed on every fact:
//   1. the registry owner is EXPLICITLY `user` or `startup` (sidebar "+" and
//      configured startup terminals; restore relaunches keep the owner). A
//      missing hint is a plain user tab to the registry, but not here;
//   2. no task / QA / task-worktree marker rides the spawn;
//   3. the cwd is not a Lattice-managed dir (a worktree or home scratch).
// Task agents, merge resolvers, workflow steps, push / QA / post-merge runs and
// prompt customizations all fail (1). The project-root reconcile sets
// `userLaunched` itself: it serves the user's own `claude` at the root.

import { isLatticeManagedCwd } from '../projectClaude/managedCwd.js';
import type { TerminalOwner } from '../terminalRegistry/types.js';
import type { McpSpawnScope } from './spawnScope.js';

export function isUserLaunchedSpawn(spawn: {
  registry?: { owner?: TerminalOwner };
  mcpScope?: McpSpawnScope;
  taskId?: string;
  isQaRun?: boolean;
  cwd?: string;
}): boolean {
  const owner = spawn.registry?.owner;
  if (owner !== 'user' && owner !== 'startup') return false;
  if (spawn.mcpScope || spawn.taskId || spawn.isQaRun) return false;
  return !!spawn.cwd && !isLatticeManagedCwd(spawn.cwd);
}
