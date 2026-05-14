import fs from 'node:fs/promises';
import { assertSafePushSessionPath } from './paths.js';
import {
  assertNotReparsePoint,
  pruneReparsePointsUnder,
} from '../worktree/cleanup.js';

export async function cleanupPushSession(projectPath: string, id: string): Promise<void> {
  try {
    const dir = assertSafePushSessionPath(projectPath, id);
    await assertNotReparsePoint(dir);

    // Claude should only leave a tiny instruction directory here, but this is
    // still a recursive delete. Strip any symlinks/junctions first so cleanup
    // cannot walk out of Lattice's home-scoped push scratch root.
    await pruneReparsePointsUnder(dir);

    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    // Best-effort cleanup — Windows file locks etc. Safety guard failures also
    // land here, before any recursive fs.rm is attempted.
    console.warn(`[pushRuns] cleanup skipped/failed for ${id}:`, err);
  }
}
