import { WebSocketServer } from 'ws';
import {
  getActiveRunsForProject as getActiveWorkflowRunsForProject,
  subscribe as subscribeWorkflowRuns,
} from '../../workflowRuns.js';
import {
  buildProjectWss,
  projectFromRunEvent,
  type ProjectRunEvent,
} from '../projectEndpoint.js';

export function buildWorkflowRunsWss(): WebSocketServer {
  return buildProjectWss<ProjectRunEvent>({
    initial: (project) => ({
      type: 'hello',
      runs: getActiveWorkflowRunsForProject(project),
    }),
    subscribe: (listener) => subscribeWorkflowRuns(listener),
    projectFromEvent: projectFromRunEvent,
  });
}
