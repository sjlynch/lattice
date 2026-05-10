import path from 'node:path';
import fs from 'node:fs/promises';

export function renderClaudeStopHookConfig(callbackUrl: string): string {
  const hookConfig = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: `curl -s -m 5 -X POST ${callbackUrl}`,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(hookConfig, null, 2);
}

export async function installClaudeStopHook(
  dir: string,
  callbackUrl: string,
): Promise<void> {
  const claudeDir = path.join(dir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'settings.local.json');
  const expected = renderClaudeStopHookConfig(callbackUrl);
  // Skip rewrite if the file already matches — keeps `git status` clean
  // when this worktree is reconciled and recreated against the same task.
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (existing === expected) return;
  } catch {
    /* file absent — fall through to write */
  }
  await fs.writeFile(file, expected, 'utf8');
}
