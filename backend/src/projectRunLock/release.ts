import type { LockBody } from './types.js';
import { deleteLockFile, readLockBody, sameLockBody } from './lockfile.js';

export async function releaseLockFile(
  file: string,
  owner: LockBody,
): Promise<void> {
  // Only delete if we still own it. Comparing the full lock body avoids a
  // late release from removing a lock that was stolen/recreated after this
  // handle was issued (including rare same-PID reuse cases).
  const current = await readLockBody(file);
  if (current && sameLockBody(current, owner)) {
    await deleteLockFile(file);
  }
}
