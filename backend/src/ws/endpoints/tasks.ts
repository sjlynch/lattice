import { WebSocketServer } from 'ws';
import { listTasks, subscribe as subscribeTasks, type Task } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import {
  subscribeTaskSpawned,
  type TaskSpawnedEvent,
} from '../../taskSpawnEvents.js';
import { buildProjectWss } from '../projectEndpoint.js';

// `/ws/tasks` carries two message types:
//   { type: 'tasks', tasks }        — full task-list snapshot (initial + live)
//   { type: 'task-spawned', ... }   — a queued task's pty just spawned; the
//                                     frontend lazy-mounts its terminal
// The `task-spawned` channel exists because a queued run has no pty at
// HTTP-response time, so the terminal can only be delivered asynchronously
// (mirrors the workflow `step-spawned` model).
type TasksWsEvent =
  | { kind: 'snapshot'; projectPath: string; tasks: Task[] }
  | { kind: 'spawned'; event: TaskSpawnedEvent };

export function buildTasksWss(): WebSocketServer {
  return buildProjectWss<TasksWsEvent>({
    initial: async (project) => ({
      type: 'tasks',
      tasks: await listTasks(project),
    }),
    initialError: 'ignore',
    subscribe: (listener) => {
      const unsubTasks = subscribeTasks((projectPath, tasks) => {
        listener({ kind: 'snapshot', projectPath, tasks });
      });
      const unsubSpawned = subscribeTaskSpawned((event) => {
        listener({ kind: 'spawned', event });
      });
      return () => {
        unsubTasks();
        unsubSpawned();
      };
    },
    // Snapshot events already carry the canonical task-cache key; a
    // task-spawned event carries the task's raw projectPath (kept raw so the
    // frontend terminal's projectPath matches `activeFolder` exactly — see
    // useTerminalGroups), so canonicalize it here for the connection filter.
    projectFromEvent: (ev) =>
      ev.kind === 'snapshot'
        ? ev.projectPath
        : canonicalProjectPath(ev.event.projectPath),
    payloadFromEvent: (ev) =>
      ev.kind === 'snapshot'
        ? { type: 'tasks', tasks: ev.tasks }
        : { type: 'task-spawned', ...ev.event },
  });
}
