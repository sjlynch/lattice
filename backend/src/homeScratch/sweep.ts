import fs from 'node:fs/promises';
import path from 'node:path';
import { forEachKnownProjectSafely } from '../recovery/projectIteration.js';
import { collectLiveSessionCwds, hasLiveSessionAtOrUnder } from '../recovery/liveSessions.js';
import type { HomeScratchPaths } from './paths.js';

// Shared boot-time convergence for home-scoped scratch dirs. The push / QA /
// post-merge-hook registries persist only their RUNNING records, and boot
// recovery (recovery/oneOffRunResume.ts) re-adopts the ones whose PTY survived;
// any on-disk session dir whose PTY is no longer live is therefore stale. This helper iterates only known projects, only directory
// entries under the feature's home scratch root, skips dirs with a live PTY cwd,
// and delegates the actual guarded recursive removal to the feature cleanup
// wrapper (which validates the id and root before deleting).
export type HomeScratchSweepDeps = {
  collectLiveSessionCwds?: typeof collectLiveSessionCwds;
  forEachKnownProjectSafely?: typeof forEachKnownProjectSafely;
};

export async function sweepOrphanedHomeScratchSessions(args: {
  label: string;
  noun: string;
  paths: HomeScratchPaths;
  cleanup: (projectPath: string, id: string) => Promise<void>;
  deps?: HomeScratchSweepDeps;
}): Promise<void> {
  const collectLive = args.deps?.collectLiveSessionCwds ?? collectLiveSessionCwds;
  const forEachProject =
    args.deps?.forEachKnownProjectSafely ?? forEachKnownProjectSafely;
  const liveCwds = await collectLive();
  if (liveCwds === null) {
    console.warn(
      `[startup] ${args.noun} sweep: terminal-server unreachable — skipping this pass ` +
        '(orphans get reclaimed on the next boot).',
    );
    return;
  }

  await forEachProject(args.label, async (repoRoot) => {
    const root = args.paths.sessionsRoot(repoRoot);
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      console.warn(
        `[startup] ${args.noun} sweep: cannot read ${root} (${code ?? 'unknown'}) — skipping.`,
      );
      return;
    }

    let removed = 0;
    for (const id of entries) {
      const dir = path.join(root, id);
      try {
        const st = await fs.stat(dir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }

      // A live PTY at/under the scratch dir means the run survived the backend
      // restart in the detached terminal-server. Leave it alone; cleanup would
      // otherwise kill exactly that session.
      if (hasLiveSessionAtOrUnder(liveCwds, dir)) {
        console.log(
          `[startup] ${args.noun} sweep: skipping ${id} — live PTY still attached`,
        );
        continue;
      }

      const before = await dirExists(dir);
      await args.cleanup(repoRoot, id);
      const after = await dirExists(dir);
      if (before && !after) removed += 1;
    }

    if (removed > 0) {
      console.log(
        `[startup] ${args.noun} sweep: reclaimed ${removed} orphaned ${args.noun} session(s) in ${repoRoot}`,
      );
    }
  });
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await fs.stat(dir);
    return true;
  } catch {
    return false;
  }
}
