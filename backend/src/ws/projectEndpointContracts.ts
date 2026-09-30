export type Unsubscribe = () => void;
export type MaybePromise<T> = T | Promise<T>;
export type ProjectEventListener<TEvent> = (event: TEvent) => void;
export type ProjectRunEvent =
  | { run: { projectPath: string } }
  | { projectPath: string };

export type ProjectWsOptions<TEvent> = {
  initial?: (project: string) => MaybePromise<unknown | void>;
  initialError?: 'close' | 'ignore';
  subscribe: (
    listener: ProjectEventListener<TEvent>,
    project: string,
  ) => MaybePromise<Unsubscribe>;
  projectFromEvent?: (event: TEvent) => string;
  payloadFromEvent?: (event: TEvent) => unknown;
  // Classifies a live event that arrives WHILE the `initial` snapshot is
  // loading (see the connect handshake in `projectConnection.ts`):
  //   - true  ⇒ a FULL snapshot of the same state `initial` loads. It is
  //     dropped and marks the in-flight load stale, so the snapshot is
  //     re-loaded (a fresh load covers it; forwarding the event itself could
  //     put an OLDER snapshot on the wire after a newer one).
  //   - false / absent ⇒ a delta or transient event (task-spawned,
  //     task-activity, registry upserts, run lifecycle, …). It is buffered and
  //     flushed, in order, right after the snapshot — never dropped, since a
  //     snapshot need not contain it.
  // Events after the handshake are always forwarded as they come.
  isSnapshotEvent?: (event: TEvent) => boolean;
};

// How many times the connect handshake loads the `initial` snapshot when
// snapshot events keep landing during the load. After the cap the latest
// loaded snapshot is sent as-is (a busy project converges on its next event).
export const MAX_INITIAL_SNAPSHOT_LOADS = 3;

// Slow-client safety net. A browser that stops reading (a throttled background
// tab, a closed laptop lid, a wedged renderer) makes `ws.send` queue in the
// backend's heap, and whole-board snapshots (/ws/tasks, the snapshot WSSs)
// are large — so past this much unsent data the connection is terminated
// instead of queuing more. The frontend reconnects and gets a fresh snapshot,
// so nothing is lost. Deliberately high: a healthy client never gets near it.
export const PROJECT_WS_HIGH_WATER_BYTES = 16 * 1024 * 1024;

// The initial load may stall while bufferedAmount is still zero. Bound the
// retained handshake events (FIFO transients plus the latest fallback snapshot)
// by both count and serialized UTF-8 bytes; overflow reconnects for a fresh
// snapshot instead of silently losing transients. Snapshot replacements reuse
// their budget rather than counting every invalidation as a retained event.
export const PROJECT_WS_MAX_PENDING_EVENTS = 4096;
export const PROJECT_WS_MAX_PENDING_BYTES = 16 * 1024 * 1024;
