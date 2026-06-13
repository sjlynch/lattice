import { WebSocketServer } from 'ws';
import {
  listAgentSessions,
  subscribeAgentSessions,
  type AgentSession,
} from '../../agentSessions.js';
import { buildProjectSnapshotWss } from '../projectEndpoint.js';

// `/ws/agent-sessions?project=` carries presence snapshots for Claude
// sessions running OUTSIDE a task worktree. The graph renders one orange
// node per session; focus beams arrive separately via `/ws/tasks`'s
// `agent-activity` messages.
//   { type: 'agent-sessions', sessions: AgentSession[] }   (initial + on change)
export function buildAgentSessionsWss(): WebSocketServer {
  return buildProjectSnapshotWss<AgentSession[]>({
    messageType: 'agent-sessions',
    snapshotKey: 'sessions',
    list: (project) => listAgentSessions(project),
    subscribe: (listener) =>
      subscribeAgentSessions((projectPath, sessions) =>
        listener(projectPath, sessions),
      ),
  });
}
