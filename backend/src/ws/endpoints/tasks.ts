import { WebSocketServer } from 'ws';
import { listTasks, subscribe as subscribeTasks } from '../../tasks.js';
import { buildProjectSnapshotWss } from '../projectEndpoint.js';

export function buildTasksWss(): WebSocketServer {
  return buildProjectSnapshotWss({
    messageType: 'tasks',
    snapshotKey: 'tasks',
    list: listTasks,
    subscribe: subscribeTasks,
  });
}
