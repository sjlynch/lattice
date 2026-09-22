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
};

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

    const attach = async () => {
      if (options.initial) {
        try {
          const payload = await options.initial(project);
          if (payload !== undefined) sendJson(ws, payload);
        } catch {
          if (options.initialError !== 'ignore') {
            ws.close();
            return;
          }
        }
      }

      let nextUnsub: Unsubscribe;
      try {
        nextUnsub = await options.subscribe((event) => {
          if (options.projectFromEvent && options.projectFromEvent(event) !== project) {
            return;
          }
          if (ws.readyState !== ws.OPEN) return;
          ws.send(serialize(event));
        }, project);
      } catch {
        ws.close();
        return;
      }

      if (closed || ws.readyState !== ws.OPEN) {
        nextUnsub();
        return;
      }
      unsub = nextUnsub;
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
    payloadFromEvent: (event) => ({
      type: options.messageType,
      [options.snapshotKey]: event.snapshot,
    }),
  });
}
