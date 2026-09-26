import { WebSocketServer } from 'ws';
import { canonicalProjectPath, isRealAbsoluteProjectPath } from '../projectPath.js';
import { handleProjectConnection } from './projectConnection.js';
import type {
  MaybePromise,
  ProjectRunEvent,
  ProjectWsOptions,
  Unsubscribe,
} from './projectEndpointContracts.js';

export { sendJson } from './projectConnection.js';
export {
  MAX_INITIAL_SNAPSHOT_LOADS,
  PROJECT_WS_HIGH_WATER_BYTES,
  type MaybePromise,
  type ProjectEventListener,
  type ProjectRunEvent,
  type ProjectWsOptions,
  type Unsubscribe,
} from './projectEndpointContracts.js';

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
  return raw && isRealAbsoluteProjectPath(raw) ? canonicalProjectPath(raw) : '';
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

    handleProjectConnection(ws, project, options, serialize);
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
