import { ProjectRunLockedError } from './errors.js';
import { isCurrentProcessHolder, isLockHolderAlive } from './liveness.js';
import { retireLockFile, readLockObservation } from './lockfile.js';

async function retireOrThrow(file: string, observed: NonNullable<Awaited<ReturnType<typeof readLockObservation>>>): Promise<void> {
  if (await retireLockFile(file, observed)) return;
  throw new Error(`[projectRunLock] ownership changed or lock retirement was interrupted at ${file}; retry after the current operation finishes. If retirement remains blocked, stop all Lattice backends before inspecting/removing only run.lock. Preserve run.lock.retired.`);
}

export async function clearStaleLockOrThrow(file: string): Promise<void> {
  const observed = await readLockObservation(file);
  if (!observed) return;
  const holder = observed.body;
  if (!holder) {
    // Lockfile exists but we can't parse it. Treat as stale and steal.
    console.warn(`[projectRunLock] unparseable lockfile at ${file} — stealing`);
    await retireOrThrow(file, observed);
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
    await retireOrThrow(file, observed);
    return;
  }

  throw new ProjectRunLockedError(holder);
}
