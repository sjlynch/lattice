import { installClaudeHooks } from '../claudeStopHook.js';
import { buildAgentActivityUrl } from '../agentActivityTokens.js';
import { installCodexStopHook } from '../codexStopHook.js';
import { installPiCompletionExtension } from '../piExtension.js';
import { installPiActivityExtension } from '../piActivity.js';
import { installPiSubagentsShim } from '../piSubagents.js';

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
  const callbackUrl = pushDoneCallbackUrl(id, backendOrigin);
  const activityUrl = buildAgentActivityUrl(backendOrigin, {
    agentId: pushAgentId(id),
    projectPath,
    label: 'push',
  });
  // Fresh scratch: install every harness's backstop, as workflow agent steps do.
  await installClaudeHooks(cwd, {
    completeUrl: callbackUrl,
    activityUrl,
  });
  await installCodexStopHook(cwd, callbackUrl, 'always', activityUrl);
  await installPiCompletionExtension({
    dir: cwd,
    callbackUrl,
    site: 'push-run-done',
    // /done kills this cwd's PTY; /fork and /reload must keep it alive.
    respectQuitGate: true,
  });
  await installPiActivityExtension({ dir: cwd, activityUrl });
  await installPiSubagentsShim({ dir: cwd });
}
