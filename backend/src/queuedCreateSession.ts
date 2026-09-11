// Spawn-queue-gated pty creation.
//
// `queuedCreateSession` is the drop-in replacement for `proxyCreateSession`
// at spawn sites whose caller needs the session result synchronously (merge
// resolvers, post-merge hook, push runs, prompt customization). It routes the
// `proxyCreateSession` call through the spawn queue so it waits for
// concurrency headroom instead of being hard-cap-rejected.
//
// The lightweight per-site setup (writing an instructions file, mkdir) runs
// BEFORE this call — only the pty allocation is queued. Sites with heavy
// setup that must also be paced (task runs: git worktree creation) instead
// enqueue the whole spawn as their own thunk; see routes/tasks/queuedSpawn.ts.
//
// Workflow steps do NOT use this helper: they enqueue fire-and-forget (the
// terminal is delivered later via the `step-spawned` WS event), so they call
// `enqueueSpawn` directly with a thunk that also emits that event.

import { proxyCreateSession, proxyKillSession } from './terminalProxy.js';
import type {
  CreateSessionOptions,
  CreateSessionResult,
} from './terminalServerClient.js';
import { cancelSpawn, enqueueSpawn, notifySessionsFreed, SpawnCapacityError, type SpawnPriority } from './spawnQueue.js';

export type QueuedCreateSessionArgs = {
  // Log/snapshot category, e.g. 'merge-run-resolver', 'push-run'.
  kind: string;
  priority: SpawnPriority;
  dedupeKey: string;
  opts: CreateSessionOptions;
  signal?: AbortSignal;
  // Bounds capacity waiting. If creation is already in flight, cancellation
  // waits for its response and cleanup instead of leaving a delayed worker.
  timeoutMs?: number;
};

class CancelledSessionCleanupError extends Error {
  constructor(kind: string, sessionId: string, cause?: unknown) {
    super(`${kind}: cancelled terminal ${sessionId} could not be confirmed stopped`, { cause });
  }
}

async function stopCancelledSession(kind: string, sessionId: string, kill: typeof proxyKillSession): Promise<void> {
  try {
    if (!await kill(sessionId)) throw new Error('terminal stop was not confirmed');
    notifySessionsFreed();
  } catch (err) { throw new CancelledSessionCleanupError(kind, sessionId, err); }
}

// Enqueue a single pty creation and resolve with its result. The returned
// promise resolves with the same `CreateSessionResult` shape `proxyCreateSession`
// returns — `{ id }` on success, `{ error }` on a non-capacity failure — so a
// caller's existing `'error' in sess` / `'id' in sess` handling is unchanged.
// A hard-cap (CAP) rejection is never surfaced as an error: it is retried
// inside the queue, so this promise simply takes longer to resolve.
export async function queuedCreateSession(
  args: QueuedCreateSessionArgs,
  deps = { proxyCreateSession, proxyKillSession },
): Promise<CreateSessionResult> {
  const controller = new AbortController();
  const abort = () => controller.abort(args.signal?.reason ?? new Error('spawn cancelled'));
  args.signal?.addEventListener('abort', abort, { once: true });
  if (args.signal?.aborted) abort();
  const signal = controller.signal;
  const timeout = args.timeoutMs === undefined ? undefined : setTimeout(() => {
    controller.abort(new Error(`${args.kind}: terminal admission timed out`));
  }, args.timeoutMs);
  timeout?.unref();
  const cancelQueued = () => { cancelSpawn(args.dedupeKey); };
  signal.addEventListener('abort', cancelQueued, { once: true });
  const throwIfCancelled = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('spawn cancelled');
  };
  try {
  throwIfCancelled();
  const { done } = enqueueSpawn<CreateSessionResult>({
    kind: args.kind,
    priority: args.priority,
    dedupeKey: args.dedupeKey,
    signal,
    thunk: async () => {
      throwIfCancelled();
      const sess = await deps.proxyCreateSession(args.opts);
      if (signal.aborted && 'id' in sess) {
        await stopCancelledSession(args.kind, sess.id, deps.proxyKillSession);
      }
      throwIfCancelled();
      // CAP is not a failure — throw so the queue releases the slot, freezes
      // admissions one poll cycle, and re-queues this thunk. Any other error
      // is returned so the caller handles it exactly as before.
      if ('error' in sess && sess.code === 'CAP') {
        throw new SpawnCapacityError(
          `${args.kind}: no terminal slot (terminal-server hard cap)`,
        );
      }
      return sess;
    },
  });
  const result = await done;
  // Cancellation can arrive after the thunk settled but before its waiter
  // resumes; ownership still belongs to this call until delivery completes.
  if (signal.aborted && 'id' in result) {
    await stopCancelledSession(args.kind, result.id, deps.proxyKillSession);
  }
  throwIfCancelled();
  return result;
  } catch (err) {
    if (signal.aborted && !(err instanceof CancelledSessionCleanupError)) throw signal.reason;
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener('abort', cancelQueued);
    args.signal?.removeEventListener('abort', abort);
  }
}
