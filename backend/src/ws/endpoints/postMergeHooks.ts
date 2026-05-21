import { WebSocketServer } from 'ws';
import {
  getActiveHookForProject,
  getMostRecentHookForProject,
  subscribePostMergeHooks,
  type PostMergeHookEvent,
} from '../../postMergeHooks.js';
import { buildProjectWss } from '../projectEndpoint.js';

// Push post-merge-hook lifecycle events to the task board so the
// PostMergeHookRow can render the running terminal banner without polling.
//
// Initial payload mirrors the GET /api/post-merge-hooks/active shape: prefer
// the active run, fall back to the most recent finished run so the UI's chip
// can show last-run status after a reload.
export function buildPostMergeHooksWss(): WebSocketServer {
  return buildProjectWss<PostMergeHookEvent>({
    initial: (project) => {
      const active = getActiveHookForProject(project);
      if (active) return { type: 'started', run: active };
      const recent = getMostRecentHookForProject(project);
      if (recent) return { type: 'finished', run: recent };
      return { type: 'idle' };
    },
    subscribe: (listener) => subscribePostMergeHooks(listener),
    projectFromEvent: (event) => event.run.projectPath,
  });
}
