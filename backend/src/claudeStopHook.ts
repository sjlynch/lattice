import path from 'node:path';
import fs from 'node:fs/promises';

// Render a Stop-hook config that runs an arbitrary shell command. Most
// call-sites use the bare `curl -s -m 5 -X POST <url>` form via
// renderClaudeStopHookConfig — the prompt-customization site needs a
// different command (`node <backstop script>`) because its callback expects
// a JSON body, so the renderer is generalised to take a command string.
export function renderClaudeStopHookConfigForCommand(command: string): string {
  const hookConfig = {
    hooks: {
      Stop: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(hookConfig, null, 2);
}

export function renderClaudeStopHookConfig(callbackUrl: string): string {
  return renderClaudeStopHookConfigForCommand(
    `curl -s -m 5 -X POST ${callbackUrl}`,
  );
}

async function writeStopHookFile(dir: string, expected: string): Promise<void> {
  const claudeDir = path.join(dir, '.claude');
  await fs.mkdir(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'settings.local.json');
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

export async function installClaudeStopHook(
  dir: string,
  callbackUrl: string,
): Promise<void> {
  await writeStopHookFile(dir, renderClaudeStopHookConfig(callbackUrl));
}

// Variant used by the prompt-customization site to invoke its backstop
// script (which posts a JSON body) instead of a bare curl.
export async function installClaudeStopHookForCommand(
  dir: string,
  command: string,
): Promise<void> {
  await writeStopHookFile(dir, renderClaudeStopHookConfigForCommand(command));
}
