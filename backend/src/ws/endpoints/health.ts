import { WebSocketServer } from 'ws';
import { subscribeHealth, type HealthUpdate } from '../../health/watcher.js';
import { buildProjectWss } from '../projectEndpoint.js';

export function buildHealthWss(): WebSocketServer {
  return buildProjectWss<HealthUpdate>({
    subscribe: (listener, project) => subscribeHealth(project, listener),
  });
}
