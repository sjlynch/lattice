import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalProjectPath } from '../projectPath.js';
import { acquireProjectRunLock } from './acquire.js';
import type { LockBody, ProjectRunLockHandle } from './types.js';

type Owner = {
  body: LockBody;
  closing: boolean;
  // false = an EXCLUSIVE holder (the workflow Run tests step): its ownership is
  // never lent to a mutation — the mutation waits until the holder releases.
  lendable: boolean;
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

// How long a mutation will wait for a closing owner to drain its borrowers
// and retire its lockfile (a handful of fs round-trips) before giving up.
const CLOSING_RETRY_TOTAL_MS = 2_000;
const CLOSING_RETRY_STEP_MS = 25;

// How long a mutation (or a post-merge hook) will wait behind an EXCLUSIVE
// holder. The only one today is a workflow Run tests step, whose agent session
// is bounded by its own timeout (at most 12 h) plus a short finalize — so this
// is a leak backstop, not a working limit.
export const EXCLUSIVE_HOLD_WAIT_MAX_MS = 13 * 60 * 60 * 1000;
const EXCLUSIVE_HOLD_POLL_MS = 500;

export function currentProjectMutationOwner(projectPath: string): LockBody | undefined {
  const context = mutationContext.getStore();
  return context?.active && context.projectPath === canonicalProjectPath(projectPath) ? context.owner.body : undefined;
}

// The label of this process's EXCLUSIVE (non-lendable) hold on the project, or
// undefined when there is none. A closing exclusive owner still counts until
// its lockfile is retired.
export function localExclusiveProjectHold(projectPath: string): LockBody | undefined {
  const owner = localOwners.get(canonicalProjectPath(projectPath));
  return owner && !owner.lendable ? owner.body : undefined;
}

export class ProjectExclusiveHoldTimeoutError extends Error {
  constructor(holder: LockBody, waitedMs: number) {
    super(
      `[projectRunLock] gave up after ${Math.round(waitedMs / 60_000)} min waiting for ` +
        `${holder.label} to release the project; retry the operation`,
    );
    this.name = 'ProjectExclusiveHoldTimeoutError';
  }
}

// Wait until this process holds no EXCLUSIVE lock on the project. Resolves at
// once when there is none. Used by every path that would otherwise change the
// main checkout under a Run tests agent: `withProjectMutation` (resolver
// finalize → snapshot + fast-forward, snapshot capture/restore) and the
// post-merge hook fired outside a merge run. They DEFER — the mutation simply
// runs once the step releases — rather than fail.
export async function waitForExclusiveProjectHold(
  projectPath: string,
  opts: { maxWaitMs?: number; pollMs?: number; onWait?: (holder: LockBody) => void } = {},
): Promise<void> {
  const key = canonicalProjectPath(projectPath);
  const started = Date.now();
  const maxWaitMs = opts.maxWaitMs ?? EXCLUSIVE_HOLD_WAIT_MAX_MS;
  let announced = false;
  for (;;) {
    const owner = localOwners.get(key);
    if (!owner || owner.lendable) return;
    if (!announced) {
      announced = true;
      (opts.onWait ?? ((holder) => console.log(
        `[projectRunLock] ${key}: deferring a repository mutation until ${holder.label} releases the project`,
      )))(owner.body);
    }
    if (Date.now() - started >= maxWaitMs) throw new ProjectExclusiveHoldTimeoutError(owner.body, Date.now() - started);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, opts.pollMs ?? EXCLUSIVE_HOLD_POLL_MS);
      t.unref?.();
    });
  }
}

// Queue only the bounded repository mutation, NEVER an agent-completion wait.
// Capture, callback re-sync/finalization, and restore share this queue. Nested
// calls in one mutation inherit its slot; unrelated async requests must queue.
//
// An EXCLUSIVE owner (the Run tests step, acquired with `lendable: false`) is
// never borrowed: its agent is editing and committing on the main checkout, so
// a resolver finalize must not snapshot + fast-forward under it. The mutation
// waits for the release instead (`waitForExclusiveProjectHold`) and then
// proceeds as if no owner had been there.
export async function withProjectMutation<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
  projectPath = canonicalProjectPath(projectPath);
  const context = mutationContext.getStore();
  if (context?.active && context.projectPath === projectPath && localOwners.get(projectPath) === context.owner) return fn();

  let acquired: ProjectRunLockHandle | undefined;
  let owner = localOwners.get(projectPath);
  // A closing owner (release() called, borrowers still draining) cannot admit
  // new work. Nothing that calls this retries — a resolver's one-shot Stop-hook
  // `/complete` that hit the old immediate throw got a 500, never signalled
  // the parked merge-run waiter, and left the run parked (and the project
  // lock held) for the waiter's 30-minute idle cap. So wait it out, briefly:
  // the owner leaves `localOwners` once its borrowers drain and its lockfile
  // is retired, after which a fresh acquisition proceeds below.
  let closingDeadline: number | undefined;
  while (owner && (owner.closing || !owner.lendable)) {
    if (!owner.lendable) {
      // Exclusive: wait for the holder to finish (it may pass through
      // `closing` on its way out — that is covered by the same wait).
      await waitForExclusiveProjectHold(projectPath);
      owner = localOwners.get(projectPath);
      continue;
    }
    closingDeadline ??= Date.now() + CLOSING_RETRY_TOTAL_MS;
    if (Date.now() >= closingDeadline) {
      throw new Error('[projectRunLock] project ownership is closing; retry the operation');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CLOSING_RETRY_STEP_MS));
    owner = localOwners.get(projectPath);
  }
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
