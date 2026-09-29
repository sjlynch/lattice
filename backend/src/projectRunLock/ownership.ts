import { canonicalProjectPath } from '../projectPath.js';
import type { LockBody, ProjectRunLockHandle } from './types.js';

export type Owner = {
  body: LockBody;
  closing: boolean;
  // false = an EXCLUSIVE holder (the workflow Run tests step): its ownership is
  // never lent to a mutation — the mutation waits until the holder releases.
  lendable: boolean;
  tail: Promise<void>;
};
const localOwners = new Map<string, Owner>();

// Internal lookup for the mutation scheduler. The caller supplies the canonical
// project path; return the live owner so queue and closing state stay shared.
export function getLocalProjectRunLockOwner(canonicalProject: string): Owner | undefined {
  return localOwners.get(canonicalProject);
}

// A process may lend its ownership to resolver callbacks while the merge worker
// waits for them. Only this registry's acquired generation may be lent; another
// backend must acquire the on-disk lock itself. Release drains accepted borrowers.
export function registerProjectRunLock(
  projectPath: string,
  body: LockBody,
  release: () => Promise<void>,
  opts: { lendable?: boolean } = {},
): ProjectRunLockHandle {
  projectPath = canonicalProjectPath(projectPath);
  const owner: Owner = { body, closing: false, lendable: opts.lendable !== false, tail: Promise.resolve() };
  localOwners.set(projectPath, owner);
  let released: Promise<void> | undefined;
  return {
    release: () => {
      if (released) return released;
      owner.closing = true;
      released = (async () => {
        await owner.tail;
        try { await release(); }
        finally {
          // The owner stays registered (closing) until the lockfile is
          // retired: an acquire attempted before that would find our own
          // pid's lock on disk and be refused outright (steal.ts), so a
          // waiting mutation must keep polling this registry instead.
          if (localOwners.get(projectPath) === owner) localOwners.delete(projectPath);
        }
      })();
      return released;
    },
  };
}
