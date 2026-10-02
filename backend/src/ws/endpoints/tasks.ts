import { WebSocketServer } from 'ws';
import { listTasks, subscribe as subscribeTasks, type Task } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import {
  subscribeTaskSpawned,
  subscribeTaskSpawnFailed,
  type TaskSpawnedEvent,
  type TaskSpawnFailedEvent,
} from '../../taskSpawnEvents.js';
import {
  subscribeTaskActivity,
  type TaskActivityEvent,
} from '../../taskActivityEvents.js';
import {
  subscribeAgentActivity,
  type AgentActivityEvent,
} from '../../agentActivity.js';
import { buildProjectWss } from '../projectEndpoint.js';

// `/ws/tasks` carries five message types:
//   { type: 'tasks', tasks }            — full task-list snapshot (initial + live)
//   { type: 'task-spawned', ... }       — a queued task's pty just spawned; the
//                                         frontend lazy-mounts its terminal
//   { type: 'task-spawn-failed', ... }  — a queued run/resume failed (non-CAP);
//                                         the frontend toasts the reason
//   { type: 'task-activity', ... }      — a Claude worktree agent is reading/
//                                         modifying a file; drives the graph's
//                                         focus beam.
//   { type: 'agent-activity', ... }     — same, for a Claude session OUTSIDE a
//                                         worktree (push / workflow step / post-
//                                         merge hook); drives the orange node.
// The `task-spawned` / `task-spawn-failed` channels exist because a queued run
// has no pty at HTTP-response time, so its outcome can only be delivered
// asynchronously (mirrors the workflow `step-spawned` model).
type TasksWsEvent =
  | { kind: 'snapshot'; projectPath: string; tasks: Task[] }
  | { kind: 'spawned'; event: TaskSpawnedEvent }
  | { kind: 'spawn-failed'; event: TaskSpawnFailedEvent }
  | { kind: 'activity'; event: TaskActivityEvent }
  | { kind: 'agent-activity'; event: AgentActivityEvent };

// `subscribe` below runs once PER CONNECTION, but one fan-out hands every
// connection's listener the SAME source object: the task cache snapshots once
// per notify and loops its listeners with that array, and the spawn/activity
// emitters pass one event object to all of theirs. Wrapping it in a fresh
// TasksWsEvent per connection made buildProjectWss's serialize-once cache
// (keyed by event identity) always miss, so every open tab re-stringified the
// whole board (1.4–6 MB) on each task change. Memoize the wrapper on its
// source so all connections forward one event; the WeakMap entry is collected
// with the source once the broadcast is done.
const snapshotEvents = new WeakMap<Task[], TasksWsEvent>();

function snapshotEvent(projectPath: string, tasks: Task[]): TasksWsEvent {
  const cached = snapshotEvents.get(tasks);
  if (cached?.kind === 'snapshot' && cached.projectPath === projectPath) return cached;
  const event: TasksWsEvent = { kind: 'snapshot', projectPath, tasks };
  snapshotEvents.set(tasks, event);
  return event;
}

function sharedWrapper<TSource extends object>(
  wrap: (source: TSource) => TasksWsEvent,
): (source: TSource) => TasksWsEvent {
  const bySource = new WeakMap<TSource, TasksWsEvent>();
  return (source) => {
    let event = bySource.get(source);
    if (event === undefined) {
      event = wrap(source);
      bySource.set(source, event);
    }
    return event;
  };
}

const spawnedEvent = sharedWrapper(
  (event: TaskSpawnedEvent): TasksWsEvent => ({ kind: 'spawned', event }),
);
const spawnFailedEvent = sharedWrapper(
  (event: TaskSpawnFailedEvent): TasksWsEvent => ({ kind: 'spawn-failed', event }),
);
const activityEvent = sharedWrapper(
  (event: TaskActivityEvent): TasksWsEvent => ({ kind: 'activity', event }),
);
const agentActivityEvent = sharedWrapper(
  (event: AgentActivityEvent): TasksWsEvent => ({ kind: 'agent-activity', event }),
);

export function buildTasksWss(): WebSocketServer {
  return buildProjectWss<TasksWsEvent>({
    initial: async (project) => ({
      type: 'tasks',
      tasks: await listTasks(project),
    }),
    initialError: 'ignore',
    subscribe: (listener) => {
      const unsubTasks = subscribeTasks((projectPath, tasks) => {
        listener(snapshotEvent(projectPath, tasks));
      });
      const unsubSpawned = subscribeTaskSpawned((event) => {
        listener(spawnedEvent(event));
      });
      const unsubSpawnFailed = subscribeTaskSpawnFailed((event) => {
        listener(spawnFailedEvent(event));
      });
      const unsubActivity = subscribeTaskActivity((event) => {
        listener(activityEvent(event));
      });
      const unsubAgentActivity = subscribeAgentActivity((event) => {
        listener(agentActivityEvent(event));
      });
      return () => {
        unsubTasks();
        unsubSpawned();
        unsubSpawnFailed();
        unsubActivity();
        unsubAgentActivity();
      };
    },
    // Snapshot events already carry the canonical task-cache key; spawned /
    // activity events carry the task's raw projectPath (kept raw so the
    // frontend terminal's projectPath matches `activeFolder` exactly — see
    // useTerminalGroups), so canonicalize it here for the connection filter.
    projectFromEvent: (ev) =>
      ev.kind === 'snapshot'
        ? ev.projectPath
        : canonicalProjectPath(ev.event.projectPath),
    // Only the task-list snapshot is re-derivable from `initial`: one landing
    // while the connect-time `listTasks` runs re-loads the list. spawned /
    // spawn-failed / activity events are transient (not in the list), so the
    // helper buffers them during the load and flushes them after it.
    isSnapshotEvent: (ev) => ev.kind === 'snapshot',
    payloadFromEvent: (ev) => {
      if (ev.kind === 'snapshot') return { type: 'tasks', tasks: ev.tasks };
      if (ev.kind === 'spawned') return { type: 'task-spawned', ...ev.event };
      if (ev.kind === 'spawn-failed')
        return { type: 'task-spawn-failed', ...ev.event };
      if (ev.kind === 'activity') return { type: 'task-activity', ...ev.event };
      return { type: 'agent-activity', ...ev.event };
    },
  });
}
