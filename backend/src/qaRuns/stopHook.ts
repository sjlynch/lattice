import { installClaudeHooks } from '../claudeStopHook.js';
import { buildAgentActivityUrl } from '../agentActivityTokens.js';

export function qaDoneCallbackUrl(id: string, backendOrigin: string): string {
  return `${backendOrigin}/api/qa-runs/${id}/done`;
}

// Stable graph-node id for a QA e2e session.
export function qaAgentId(id: string): string {
  return `qa:${id}`;
}

export async function installQaStopHook(
  cwd: string,
  id: string,
  backendOrigin: string,
  projectPath: string,
): Promise<void> {
  await installClaudeHooks(cwd, {
    completeUrl: qaDoneCallbackUrl(id, backendOrigin),
    activityUrl: buildAgentActivityUrl(backendOrigin, {
      agentId: qaAgentId(id),
      projectPath,
      label: 'qa',
    }),
  });
}
