import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalProjectPath } from '../projectPath.js';
import { acquireProjectRunLock } from './acquire.js';
import type { LockBody, ProjectRunLockHandle } from './types.js';

type Owner = {
  body: LockBody;
  closing: boolean;
  tail: Promise<void>;
};
const localOwners = new Map<string, Owner>();
const pendingAcquisitions = new Map<string, Promise<ProjectRunLockHandle>>();
const mutationContext = new AsyncLocalStorage<{ projectPath: string; owner: Owner; active: boolean }>();

// A process may lend its ownership to resolver callbacks while the merge worker
// waits for them. Only this registry's acquired generation may be lent; another
// backend must acquire the on-disk lock itself. Release drains accepted borrowers.
export function registerProjectRunLock(
  projectPath: string,
  body: LockBody,
  release: () => Promise<void>,
): ProjectRunLockHandle {
  projectPath = canonicalProjectPath(projectPath);
  const owner: Owner = { body, closing: false, tail: Promise.resolve() };
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
          if (localOwners.get(projectPath) === owner) localOwners.delete(projectPath);
        }
      })();
      return released;
    },
  };
}

export function currentProjectMutationOwner(projectPath: string): LockBody | undefined {
  const context = mutationContext.getStore();
  return context?.active && context.projectPath === canonicalProjectPath(projectPath) ? context.owner.body : undefined;
}

// Queue only the bounded repository mutation, NEVER an agent-completion wait.
// Capture, callback re-sync/finalization, and restore share this queue. Nested
// calls in one mutation inherit its slot; unrelated async requests must queue.
export async function withProjectMutation<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  projectPath = canonicalProjectPath(projectPath);
  const context = mutationContext.getStore();
  if (context?.active && context.projectPath === projectPath && localOwners.get(projectPath) === context.owner) return fn();

  let acquired: ProjectRunLockHandle | undefined;
  let owner = localOwners.get(projectPath);
  if (!owner) {
    let pending = pendingAcquisitions.get(projectPath);
    if (!pending) {
      pending = acquireProjectRunLock(projectPath, 'project-mutation');
      pendingAcquisitions.set(projectPath, pending);
    }
    try { acquired = await pending; }
    finally {
      if (pendingAcquisitions.get(projectPath) === pending) pendingAcquisitions.delete(projectPath);
    }
    owner = localOwners.get(projectPath)!;
  }
  if (owner.closing) throw new Error('[projectRunLock] project ownership is closing; retry the operation');
  const previous = owner.tail;
  let complete!: () => void;
  owner.tail = new Promise<void>((resolve) => { complete = resolve; });
  const nextContext = { projectPath, owner, active: true };
  try {
    await previous;
    return await mutationContext.run(nextContext, fn);
  } finally {
    nextContext.active = false;
    complete();
    await acquired?.release();
  }
}
