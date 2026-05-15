import { release, tryAcquire } from '../../mergeLocks.js';

export type ManualMergeLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

export async function withManualMergeLock<T>(
  taskId: string,
  callback: () => Promise<T>,
): Promise<ManualMergeLockResult<T>> {
  if (!tryAcquire(taskId)) return { acquired: false };

  try {
    return { acquired: true, value: await callback() };
  } finally {
    release(taskId);
  }
}
