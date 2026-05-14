import { installClaudeStopHook } from '../claudeStopHook.js';

export function pushDoneCallbackUrl(id: string, backendOrigin: string): string {
  return `${backendOrigin}/api/push-runs/${id}/done`;
}

export async function installPushStopHook(
  cwd: string,
  id: string,
  backendOrigin: string,
): Promise<void> {
  await installClaudeStopHook(cwd, pushDoneCallbackUrl(id, backendOrigin));
}
