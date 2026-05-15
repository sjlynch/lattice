import { WebSocketServer } from 'ws';
import {
  getActiveRunForProject,
  subscribe as subscribeMergeRuns,
} from '../../mergeRuns.js';
import {
  buildProjectWss,
  projectFromRunEvent,
  type ProjectRunEvent,
} from '../projectEndpoint.js';

export function buildMergeRunsWss(): WebSocketServer {
  return buildProjectWss<ProjectRunEvent>({
    // Always send current state on connect so the UI re-syncs after a WS
    // reconnect. If no run is active, send 'idle' so the client can clear
    // any stale run state it was showing before the connection dropped.
    initial: (project) => {
      const active = getActiveRunForProject(project);
      return active ? { type: 'started', run: active } : { type: 'idle' };
    },
    subscribe: (listener) => subscribeMergeRuns(listener),
    projectFromEvent: projectFromRunEvent,
  });
}
