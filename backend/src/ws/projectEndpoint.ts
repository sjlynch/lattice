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

export function parseProject(reqUrl: string | undefined): string {
  const url = new URL(reqUrl || '', 'http://localhost');
  const raw = url.searchParams.get('project') || '';
  return raw ? canonicalProjectPath(raw) : '';
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
  wss.on('connection', (ws, req) => {
    const project = parseProject(req.url);
    if (!project) {
      ws.close();
      return;
    }

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
          sendJson(
            ws,
            options.payloadFromEvent ? options.payloadFromEvent(event) : event,
          );
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
