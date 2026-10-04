import { collectLiveSessionCwds, hasLiveSessionAtOrUnder } from '../recovery/liveSessions.js';
import { forEachKnownProjectSafely } from '../recovery/projectIteration.js';
import { sweepOrphanedHomeScratchSessions } from '../homeScratch/sweep.js';
import { registerAgentSession } from '../agentSessions.js';
import { readReviewStore } from './reviewStore.js';
import { cleanupReview, finishReview, reviewAgentId, reviewPaths } from './reviewSession.js';

const projects = new Set<string>();
const goneSince = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
export function watchSecurityReviews(project: string) {
  projects.add(project);
  if (!timer) { timer = setInterval(() => void tick().catch(console.error), 30_000); timer.unref(); }
}
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const live = await collectLiveSessionCwds();
    if (live === null) return; // Unreachable is never evidence of a dead PTY.
    for (const project of projects) {
      const running = (await readReviewStore(project)).runs.filter((r) => r.status === 'running');
      if (!running.length) { projects.delete(project); continue; }
      for (const run of running) {
        const key = `${project}\0${run.id}`;
        const alive = hasLiveSessionAtOrUnder(live, reviewPaths.assertSafeSessionPath(project, run.id));
        if (alive) goneSince.delete(key);
        else if (!goneSince.has(key)) goneSince.set(key, Date.now());
        if (!alive && Date.now() - goneSince.get(key)! >= 90_000 || Date.now() - run.createdAt >= 2 * 60 * 60_000) {
          await finishReview(project, run.id); goneSince.delete(key);
        }
      }
    }
    if (!projects.size && timer) { clearInterval(timer); timer = undefined; goneSince.clear(); }
  } finally { busy = false; }
}
export async function recoverSecurityReviews() {
  // Callbacks read their persistent record directly, so no memory-only registry
  // can cause a 404 after restart. Rebuild presence and the liveness backstop.
  await forEachKnownProjectSafely('recoverSecurityReviews', async (project) => {
    for (const run of (await readReviewStore(project)).runs.filter((r) => r.status === 'running')) {
      reviewPaths.assertSafeSessionPath(project, run.id);
      registerAgentSession({ agentId: reviewAgentId(run.id), projectPath: project, label: 'Security review', harness: run.harness });
      watchSecurityReviews(project);
    }
  });
}
export async function sweepSecurityReviews() {
  await sweepOrphanedHomeScratchSessions({ label: 'sweepSecurityReviews', noun: 'security review', paths: reviewPaths,
    cleanup: async (project, id) => {
      // Give a delayed Stop callback the watchdog grace period to collect its
      // report before reclaiming the only copy of that output.
      if ((await readReviewStore(project)).runs.some((r) => r.id === id && r.status === 'running')) return;
      await cleanupReview(project, id);
    } });
}
