import { ProjectRunLockedError } from './errors.js';
import { isCurrentProcessHolder, isLockHolderAlive } from './liveness.js';
import { deleteLockFile, readLockBody } from './lockfile.js';

export async function clearStaleLockOrThrow(file: string): Promise<void> {
  const holder = await readLockBody(file);
  if (!holder) {
    // Lockfile exists but we can't parse it. Treat as stale and steal.
    console.warn(`[projectRunLock] unparseable lockfile at ${file} — stealing`);
    await deleteLockFile(file);
    return;
  }

  // Same-process re-entry would deadlock the merge run worker. The
  // in-process locks (mergeLocks.ts, the singleton run check in
  // mergeRuns.ts) are responsible for catching this case before we get
  // here; if they didn't, refuse rather than silently pretending we're
  // the holder.
  if (isCurrentProcessHolder(holder)) {
    throw new ProjectRunLockedError(holder);
  }

  if (!(await isLockHolderAlive(holder))) {
    console.warn(
      `[projectRunLock] stealing dead lock held by pid=${holder.pid} ` +
        `(label=${holder.label}, started ${new Date(holder.startedAt).toISOString()})`,
    );
    await deleteLockFile(file);
    return;
  }

  throw new ProjectRunLockedError(holder);
}
