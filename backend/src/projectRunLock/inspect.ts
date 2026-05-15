import { projectRunLockFilePath } from './paths.js';
import { isLockHolderAlive } from './liveness.js';
import { readLockBody } from './lockfile.js';
import type { ProjectRunLockInspection } from './types.js';

// Inspect (without acquiring or stealing) the run lock for a project.
// Returns `{ holder, alive }` — `alive` is whether the owning PID is still
// running (a lock from another host is conservatively reported alive,
// since we can't probe a remote PID). `null` when there is no lockfile or
// it's unparseable. Boot recovery uses this to spot a merge run that a
// server restart killed mid-flight (lock present, label `merge-run`,
// owner dead) and resume it.
export async function inspectProjectRunLock(
  projectPath: string,
): Promise<ProjectRunLockInspection | null> {
  const body = await readLockBody(projectRunLockFilePath(projectPath));
  if (!body) return null;
  return { holder: body, alive: isLockHolderAlive(body) };
}
