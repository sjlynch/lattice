import { installClaudeHooks } from '../claudeStopHook.js';
import { buildAgentActivityUrl } from '../agentActivity.js';

export function pushDoneCallbackUrl(id: string, backendOrigin: string): string {
  return `${backendOrigin}/api/push-runs/${id}/done`;
}

// Stable graph-node id for a push session.
export function pushAgentId(id: string): string {
  return `push:${id}`;
}

export async function installPushStopHook(
  cwd: string,
  id: string,
  backendOrigin: string,
  projectPath: string,
): Promise<void> {
  await installClaudeHooks(cwd, {
    completeUrl: pushDoneCallbackUrl(id, backendOrigin),
    activityUrl: buildAgentActivityUrl(backendOrigin, {
      agentId: pushAgentId(id),
      projectPath,
      label: 'push',
    }),
  });
}
