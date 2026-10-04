import { collectLiveSessionCwds, hasLiveSessionAtOrUnder } from '../recovery/liveSessions.js';
import { forEachKnownProjectSafely } from '../recovery/projectIteration.js';
import { sweepOrphanedHomeScratchSessions } from '../homeScratch/sweep.js';
import { registerAgentSession, unregisterAgentSession } from '../agentSessions.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { canonicalProjectPath } from '../projectPath.js';
import { isActiveReview, readReviewStore, updateReviewStore } from './reviewStore.js';
import { cleanupReview, isPendingReview, reviewAgentId, reviewPaths } from './reviewSession.js';

const projects = new Set<string>();
const goneSince = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
export function watchSecurityReviews(project: string) {
  projects.add(project);
  if (!timer) { timer = setInterval(() => void tick().catch(console.error), 30_000); timer.unref(); }
}

export async function reconcileSecurityReviews(project: string, live: Set<string> | null, deps: {
  now?: () => number; registry?: Pick<typeof terminalRegistry, 'get'>; cleanup?: typeof cleanupReview; pending?: typeof isPendingReview;
} = {}) {
  if (live === null) return; // Unreachable is never evidence of a dead PTY.
  const now = (deps.now ?? Date.now)();
  for (const run of (await readReviewStore(project)).runs.filter(isActiveReview)) {
    const key = `${canonicalProjectPath(project)}\0${run.id}`;
    const alive = hasLiveSessionAtOrUnder(live, reviewPaths.assertSafeSessionPath(project, run.id));
    const terminal = run.terminalId ? await (deps.registry ?? terminalRegistry).get(run.terminalId, project) : null;
    // The registry owns conversation restore. Its cwd must survive executor
    // replacement, queued relaunches, retryable failures and long user absences.
    if (alive || (terminal && !terminal.closePending) || (deps.pending ?? isPendingReview)(project, run.id)) {
      goneSince.delete(key); continue;
    }
    const goneAt = goneSince.get(key) ?? now;
    goneSince.set(key, goneAt);
    if (now - goneAt < 90_000) continue;
    await updateReviewStore(project, (store) => {
      const current = store.runs.find((r) => r.id === run.id);
      if (current && isActiveReview(current)) { current.status = 'closed'; current.finishedAt = current.updatedAt = now; }
    });
    unregisterAgentSession(reviewAgentId(run.id));
    await (deps.cleanup ?? cleanupReview)(project, run.id);
    goneSince.delete(key);
  }
}
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const live = await collectLiveSessionCwds();
    for (const project of projects) {
      await reconcileSecurityReviews(project, live);
      if (!(await readReviewStore(project)).runs.some(isActiveReview)) projects.delete(project);
    }
    if (!projects.size && timer) { clearInterval(timer); timer = undefined; goneSince.clear(); }
  } finally { busy = false; }
}
export async function recoverSecurityReviews() {
  await forEachKnownProjectSafely('recoverSecurityReviews', async (project) => {
    for (const run of (await readReviewStore(project)).runs.filter(isActiveReview)) {
      reviewPaths.assertSafeSessionPath(project, run.id);
      registerAgentSession({ agentId: reviewAgentId(run.id), projectPath: project, label: 'Security review', harness: run.harness });
      watchSecurityReviews(project);
    }
  });
}
export async function sweepSecurityReviews() {
  await sweepOrphanedHomeScratchSessions({ label: 'sweepSecurityReviews', noun: 'security review', paths: reviewPaths,
    cleanup: async (project, id) => {
      if ((await readReviewStore(project)).runs.some((r) => r.id === id && isActiveReview(r))) return;
      const cwd = reviewPaths.assertSafeSessionPath(project, id);
      // Even a terminal with a missing PTY may be waiting to resume.
      if ((await terminalRegistry.list(project, { includeEnded: true })).some((r) => !r.closePending && canonicalProjectPath(r.cwd) === canonicalProjectPath(cwd))) return;
      await cleanupReview(project, id);
    } });
}
