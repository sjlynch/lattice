// "Is the operation holding this project's run.lock parked on a live agent?"
//
// The dev runner force-restarts after MAX_DEFER_MS when a merge-run /
// manual-merge lock is still held (backend/scripts/dev/restartPolicy.mjs) —
// the backstop for a WEDGED holder. But a merge run legitimately holds its lock
// for as long as a conflict-resolver agent or the post-merge hook agent takes,
// and forcing a restart there interrupts working agents for nothing. Only this
// process knows which case it is in, so it answers per project hash:
//
//   - `conflict-resolver`: a live merge run is parked on a resolver waiter
//     (mergeRuns/waiterLiveness.ts bounds that wait: a dead pty is released in
//     ~75 s, 30 min without output pauses the run) AND the resolver's pty is
//     alive in the terminal-server (or the probe couldn't tell / the spawn is
//     still queued — both of which are bounded by that same wrapper);
//   - `post-merge-hook`: the project has a running post-merge hook whose pty
//     is alive (same "can't tell ⇒ alive" rule; its wait has its own cap in
//     postMergeHooks/registry.ts `waitForPostMergeHook`).
//
// Anything else (a live merge run between tasks, a resolver whose pty is
// confirmed gone) is reported with `parkedOn: null`, and the backstop keeps
// its old meaning for it.

import { listLiveMergeRunResolverWaits } from '../mergeRuns.js';
import { getActiveHookForProject } from '../postMergeHooks.js';
import { canonicalProjectPath, projectHash } from '../projectPath.js';
import { listKnownProjects } from '../tasks.js';
import { proxyListSessionsOrNull } from '../terminalServerClient.js';

export type LockHolderParkedOn = 'conflict-resolver' | 'post-merge-hook';

export type LockHolderReport = {
  hash: string;
  project: string;
  parkedOn: LockHolderParkedOn | null;
  detail: string;
};

export type LockHolderDeps = {
  listLiveMergeRuns: typeof listLiveMergeRunResolverWaits;
  activeHookForProject: (projectPath: string) => { id: string; serverId?: string } | null;
  knownProjects: () => Promise<string[]>;
  listSessions: () => Promise<unknown[] | null>;
};

const productionDeps: LockHolderDeps = {
  listLiveMergeRuns: listLiveMergeRunResolverWaits,
  activeHookForProject: getActiveHookForProject,
  knownProjects: listKnownProjects,
  listSessions: proxyListSessionsOrNull,
};

// null = the terminal-server could not be asked ("can't tell" — never "dead").
function sessionAlive(sessions: unknown[] | null, id: string | undefined): boolean | null {
  if (!id || sessions === null) return null;
  return sessions.some((s) => (s as { id?: unknown } | null)?.id === id);
}

export async function describeLockHolders(deps: LockHolderDeps = productionDeps): Promise<LockHolderReport[]> {
  const liveRuns = deps.listLiveMergeRuns();
  const projects = new Set<string>(liveRuns.map((r) => canonicalProjectPath(r.run.projectPath)));
  for (const p of await deps.knownProjects().catch(() => [] as string[])) projects.add(canonicalProjectPath(p));
  const hooks = new Map<string, { id: string; serverId?: string }>();
  for (const p of projects) {
    const hook = deps.activeHookForProject(p);
    if (hook) hooks.set(p, hook);
  }
  // One terminal-server probe per report, and only when something could use it.
  const needProbe = hooks.size > 0 || liveRuns.some((r) => r.resolverTaskIds.length > 0);
  const sessions = needProbe ? await deps.listSessions().catch(() => null) : null;

  const reports: LockHolderReport[] = [];
  for (const project of projects) {
    const hash = projectHash(project);
    const runs = liveRuns.filter((r) => canonicalProjectPath(r.run.projectPath) === project);
    let parkedOn: LockHolderParkedOn | null = null;
    const details: string[] = [];
    for (const { run, resolverTaskIds } of runs) {
      for (const taskId of resolverTaskIds) {
        const sessionId = run.resolvers?.[taskId]?.sessionId;
        const alive = sessionAlive(sessions, sessionId);
        if (alive === false) {
          details.push(`merge run ${run.id} waits on resolver for task ${taskId} whose pty ${sessionId} is gone`);
          continue;
        }
        parkedOn = 'conflict-resolver';
        details.push(
          `merge run ${run.id} parked on the conflict resolver for task ${taskId}` +
            (alive === null ? (sessionId ? ' (pty liveness unknown)' : ' (resolver spawn pending)') : ` (pty ${sessionId} alive)`),
        );
      }
      if (resolverTaskIds.length === 0) details.push(`merge run ${run.id} running (not parked on an agent)`);
    }
    const hook = hooks.get(project);
    if (hook) {
      const alive = sessionAlive(sessions, hook.serverId);
      if (alive === false) {
        details.push(`post-merge hook ${hook.id} running but its pty ${hook.serverId} is gone`);
      } else {
        parkedOn ??= 'post-merge-hook';
        details.push(
          `post-merge hook ${hook.id} running` +
            (alive === null ? (hook.serverId ? ' (pty liveness unknown)' : ' (spawn pending)') : ` (pty ${hook.serverId} alive)`),
        );
      }
    }
    if (details.length === 0) continue; // nothing in flight here — not worth reporting
    reports.push({ hash, project, parkedOn, detail: details.join('; ') });
  }
  return reports;
}
