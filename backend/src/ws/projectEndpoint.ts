import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { canonicalProjectPath } from '../projectPath.js';

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
  // loading (see the connect handshake in `buildProjectWss`):
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

// A relative `project` is refused (empty ⇒ the connection handler closes the
// socket), matching the HTTP routes' rule. Canonicalising it first defeated
// the task cache's own read-path guard (`ensureProjectLoaded` only skips
// indexing when the path it is HANDED is relative), so `?project=foo` used to
// register `<backend cwd>/foo` in `~/.lattice/projects.json` and write a junk
// identity binding for it.
export function parseProject(reqUrl: string | undefined): string {
  let raw: string;
  try {
    raw = new URL(reqUrl || '', 'http://localhost').searchParams.get('project') || '';
  } catch {
    // Malformed request target — same as no project (the socket is closed).
    return '';
  }
  return raw && path.isAbsolute(raw) ? canonicalProjectPath(raw) : '';
}

export function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

export function projectFromRunEvent(ev: ProjectRunEvent): string {
  return 'run' in ev ? ev.run.projectPath : ev.projectPath;
}

export function buildProjectWss<TEvent>(
  options: ProjectWsOptions<TEvent>,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  // One broadcast event is fanned out to every subscribed connection by
  // invoking each connection's listener with the *same* event object (e.g. the
  // health watcher loops `proj.subscribers` calling `sub(update)`). Serialize
  // that payload once and reuse the string across clients instead of
  // JSON.stringify-ing it per connection — with several tabs open on one
  // project this was N× redundant serialization on the health hot path. Keyed
  // by event identity in a WeakMap so the cached string is collected with the
  // (short-lived) event after the broadcast, and each new broadcast serializes
  // exactly once. Byte-identical on the wire to sendJson(ws, payload).
  const serializedByEvent = new WeakMap<object, string>();
  const serialize = (event: TEvent): string => {
    const stringify = () =>
      JSON.stringify(
        options.payloadFromEvent ? options.payloadFromEvent(event) : event,
      );
    if (event === null || typeof event !== 'object') return stringify();
    const key = event as object;
    const cached = serializedByEvent.get(key);
    if (cached !== undefined) return cached;
    const str = stringify();
    serializedByEvent.set(key, str);
    return str;
  };

  wss.on('connection', (ws, req) => {
    const project = parseProject(req.url);
    if (!project) {
      ws.close();
      return;
    }

    // ws v8 re-throws a socket 'error' as an uncaughtException when no listener
    // is registered. An abrupt client disconnect (ECONNRESET/EPIPE from a killed
    // tab, network partition, OS sleep, or a vite-proxy hard-drop) is routine,
    // not fatal — log-and-ignore so it can't masquerade as a backend crash. The
    // 'close' handler below still runs and tears down the subscription. Covers
    // every project-scoped WS (/ws/tasks, /ws/health, /ws/merge-runs, …) since
    // they all share this connection body.
    ws.on('error', () => { /* routine client disconnect — ignore */ });

    let unsub: Unsubscribe | null = null;
    let closed = false;
    ws.on('close', () => {
      closed = true;
      if (unsub) {
        unsub();
        unsub = null;
      }
    });

    const forward = (event: TEvent) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(serialize(event));
    };

    // Connect handshake: SUBSCRIBE FIRST, then load the initial snapshot.
    // Loading first (the old order) lost any event fired during the await —
    // e.g. a task change while `listTasks` ran — until the next change. While
    // `loading`, live events are held back per `isSnapshotEvent`: snapshot
    // events mark the load `dirty` (→ re-load), deltas queue in `pending` and
    // are flushed after the snapshot. Nothing is sent before the snapshot, and
    // a snapshot event is never sent after a newer loaded snapshot.
    let loading = options.initial !== undefined;
    let dirty = false;
    let lastSnapshotEvent: { event: TEvent } | null = null;
    const pending: TEvent[] = [];

    const onEvent = (event: TEvent) => {
      if (options.projectFromEvent && options.projectFromEvent(event) !== project) {
        return;
      }
      if (loading) {
        if (options.isSnapshotEvent?.(event)) {
          dirty = true;
          lastSnapshotEvent = { event };
        } else {
          pending.push(event);
        }
        return;
      }
      forward(event);
    };

    const attach = async () => {
      let nextUnsub: Unsubscribe;
      try {
        nextUnsub = await options.subscribe(onEvent, project);
      } catch {
        ws.close();
        return;
      }
      if (closed || ws.readyState !== ws.OPEN) {
        nextUnsub();
        return;
      }
      // From here the 'close' handler owns teardown, so a socket that closes
      // mid-load unsubscribes (no leaked listener).
      unsub = nextUnsub;
      if (!options.initial) return;

      let payload: unknown;
      let loaded = false;
      for (let attempt = 0; attempt < MAX_INITIAL_SNAPSHOT_LOADS; attempt++) {
        dirty = false;
        lastSnapshotEvent = null;
        try {
          payload = await options.initial(project);
          loaded = true;
        } catch {
          if (options.initialError !== 'ignore') {
            ws.close();
            return;
          }
          // Keep the last good load (if any) rather than nothing.
          break;
        }
        if (closed) return;
        if (!dirty) break;
      }

      loading = false;
      if (loaded) {
        if (payload !== undefined) sendJson(ws, payload);
      } else if (lastSnapshotEvent) {
        // No snapshot could be loaded ('ignore'), so nothing newer is on the
        // wire: the latest live snapshot is the best the client can get.
        forward((lastSnapshotEvent as { event: TEvent }).event);
      }
      lastSnapshotEvent = null;
      for (const event of pending.splice(0)) forward(event);
    };

    attach().catch(() => {
      ws.close();
    });
  });
  return wss;
}

export function buildProjectSnapshotWss<TSnapshot>(options: {
  messageType: string;
  snapshotKey: string;
  list: (project: string) => MaybePromise<TSnapshot>;
  subscribe: (
    listener: (project: string, snapshot: TSnapshot) => void,
  ) => Unsubscribe;
}): WebSocketServer {
  return buildProjectWss<{ projectPath: string; snapshot: TSnapshot }>({
    initial: async (project) => ({
      type: options.messageType,
      [options.snapshotKey]: await options.list(project),
    }),
    initialError: 'ignore',
    subscribe: (listener) => options.subscribe((projectPath, snapshot) => {
      listener({ projectPath, snapshot });
    }),
    projectFromEvent: (event) => event.projectPath,
    // Every event IS a full snapshot: one landing mid-load re-loads instead.
    isSnapshotEvent: () => true,
    payloadFromEvent: (event) => ({
      type: options.messageType,
      [options.snapshotKey]: event.snapshot,
    }),
  });
}
