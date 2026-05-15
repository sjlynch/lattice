import { acquireProjectRunLock } from './acquire.js';

// Convenience for the "do work, always release" pattern. Runs `fn` with
// the lock held; releases on success and on throw.
export async function withProjectRunLock<T>(
  projectPath: string,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await acquireProjectRunLock(projectPath, label);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
