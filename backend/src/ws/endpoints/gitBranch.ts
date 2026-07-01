import { WebSocketServer } from 'ws';
import { subscribeGitBranch } from '../../gitBranch.js';
import { buildProjectWss } from '../projectEndpoint.js';

// Pushes the active project's current git branch: once on connect and again
// whenever `.git/HEAD` changes (a terminal or the user runs `git checkout`), so
// the navbar branch chip updates live instead of only after a page refresh.
export function buildGitBranchWss(): WebSocketServer {
  return buildProjectWss<{ branch: string | null }>({
    subscribe: (listener, project) =>
      subscribeGitBranch(project, (branch) => listener({ branch })),
    payloadFromEvent: (event) => ({ type: 'git-branch', branch: event.branch }),
  });
}
