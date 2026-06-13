import { WebSocketServer } from 'ws';
import { listTasks, subscribe as subscribeTasks, type Task } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import {
  subscribeTaskSpawned,
  type TaskSpawnedEvent,
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

// `/ws/tasks` carries four message types:
//   { type: 'tasks', tasks }        — full task-list snapshot (initial + live)
//   { type: 'task-spawned', ... }   — a queued task's pty just spawned; the
//                                     frontend lazy-mounts its terminal
//   { type: 'task-activity', ... }  — a Claude worktree agent is reading/
//                                     modifying a file; drives the graph's
//                                     focus beam.
//   { type: 'agent-activity', ... } — same, for a Claude session OUTSIDE a
//                                     worktree (push / workflow step / post-
//                                     merge hook); drives the orange node.
// The `task-spawned` channel exists because a queued run has no pty at
// HTTP-response time, so the terminal can only be delivered asynchronously
// (mirrors the workflow `step-spawned` model).
type TasksWsEvent =
  | { kind: 'snapshot'; projectPath: string; tasks: Task[] }
  | { kind: 'spawned'; event: TaskSpawnedEvent }
  | { kind: 'activity'; event: TaskActivityEvent }
  | { kind: 'agent-activity'; event: AgentActivityEvent };

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
      const unsubActivity = subscribeTaskActivity((event) => {
        listener({ kind: 'activity', event });
      });
      const unsubAgentActivity = subscribeAgentActivity((event) => {
        listener({ kind: 'agent-activity', event });
      });
      return () => {
        unsubTasks();
        unsubSpawned();
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
    payloadFromEvent: (ev) => {
      if (ev.kind === 'snapshot') return { type: 'tasks', tasks: ev.tasks };
      if (ev.kind === 'spawned') return { type: 'task-spawned', ...ev.event };
      if (ev.kind === 'activity') return { type: 'task-activity', ...ev.event };
      return { type: 'agent-activity', ...ev.event };
    },
  });
}
