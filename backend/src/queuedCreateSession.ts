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

import { proxyCreateSession } from './terminalProxy.js';
import type {
  CreateSessionOptions,
  CreateSessionResult,
} from './terminalServerClient.js';
import { enqueueSpawn, SpawnCapacityError, type SpawnPriority } from './spawnQueue.js';

export type QueuedCreateSessionArgs = {
  // Log/snapshot category, e.g. 'merge-run-resolver', 'push-run'.
  kind: string;
  priority: SpawnPriority;
  dedupeKey: string;
  opts: CreateSessionOptions;
};

// Enqueue a single pty creation and resolve with its result. The returned
// promise resolves with the same `CreateSessionResult` shape `proxyCreateSession`
// returns — `{ id }` on success, `{ error }` on a non-capacity failure — so a
// caller's existing `'error' in sess` / `'id' in sess` handling is unchanged.
// A hard-cap (CAP) rejection is never surfaced as an error: it is retried
// inside the queue, so this promise simply takes longer to resolve.
export async function queuedCreateSession(
  args: QueuedCreateSessionArgs,
): Promise<CreateSessionResult> {
  const { done } = enqueueSpawn<CreateSessionResult>({
    kind: args.kind,
    priority: args.priority,
    dedupeKey: args.dedupeKey,
    thunk: async () => {
      const sess = await proxyCreateSession(args.opts);
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
  return done;
}
