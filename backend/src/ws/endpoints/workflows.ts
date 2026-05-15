import { WebSocketServer } from 'ws';
import {
  listWorkflows,
  subscribe as subscribeWorkflows,
} from '../../workflows.js';
import { buildProjectSnapshotWss } from '../projectEndpoint.js';

export function buildWorkflowsWss(): WebSocketServer {
  return buildProjectSnapshotWss({
    messageType: 'workflows',
    snapshotKey: 'workflows',
    list: listWorkflows,
    subscribe: subscribeWorkflows,
  });
}
