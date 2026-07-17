import { WebSocketServer } from 'ws';
import { subscribeGitStatus } from '../../gitStatus.js';
import { buildProjectWss } from '../projectEndpoint.js';

// Pushes a compact "git status changed" signal for the active project: once on
// connect and again whenever a commit / stage / checkout / merge / reset OR a
// working-tree edit changes the repo's status signature. The frontend timeline
// scrubber re-fetches /api/git-history on a new signature (deduped against the
// one it last fetched), so the commit list + uncommitted-changes view update
// live instead of only after a page refresh.
export function buildGitStatusWss(): WebSocketServer {
  return buildProjectWss<{ signature: string }>({
    subscribe: (listener, project) =>
      subscribeGitStatus(project, (signature) => listener({ signature })),
    payloadFromEvent: (event) => ({ type: 'git-status', signature: event.signature }),
  });
}
