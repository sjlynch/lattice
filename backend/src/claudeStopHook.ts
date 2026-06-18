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

// Tools whose `tool_input` carries a single file the agent is reading or
// modifying. The graph's activity overlay draws a focus beam to each. Glob /
// Grep / Bash are deliberately excluded — they don't name one target file.
const ACTIVITY_TOOL_MATCHER = 'Read|Edit|Write|MultiEdit|NotebookEdit';

export type ClaudeHookUrls = {
  // Stop-hook callback (task `/complete`). Always present.
  completeUrl: string;
  // PreToolUse + PostToolUse callback (task `/activity`). When set, the two
  // tool hooks are added so the worktree agent reports which file it is
  // touching. Omit for non-Claude harnesses (no such hooks) or to install
  // just the Stop backstop.
  activityUrl?: string;
};

// Build the full `.claude/settings.local.json` body. The activity hooks
// forward Claude's hook JSON (delivered on stdin) verbatim as the POST body
// via `-d @-`; the backend reads `hook_event_name` to tell a Pre from a Post
// and `tool_input.file_path` for the target. `-m 2` keeps a slow/absent
// backend from stalling the agent's tool call; the endpoint replies 204 with
// no body, so `-s` alone keeps the agent's transcript clean (no `-o
// /dev/null`, which Windows curl can't open). curl's exit code on a failed
// POST is 7/28 (never 2), so a PreToolUse hook never blocks the tool.
export function renderClaudeHooksConfig(urls: ClaudeHookUrls): string {
  const hooks: Record<string, unknown[]> = {
    Stop: [
      {
        matcher: '',
        hooks: [
          { type: 'command', command: `curl -s -m 5 -X POST ${urls.completeUrl}` },
        ],
      },
    ],
  };
  if (urls.activityUrl) {
    const activityCommand =
      `curl -s -m 2 -X POST ` +
      `-H "Content-Type: application/json" -d @- ${urls.activityUrl}`;
    const command = [{ type: 'command', command: activityCommand }];
    // File tool-use → focus beams. A subagent's own tool-use fires these too,
    // carrying `agent_id`, so the backend can route the beam to its satellite.
    const block = [{ matcher: ACTIVITY_TOOL_MATCHER, hooks: command }];
    hooks.PreToolUse = block;
    hooks.PostToolUse = block;
    // Subagent (Task/Agent) lifecycle → a satellite node appears/disappears
    // around the agent's Claude node. No matcher = every agent type. The same
    // endpoint reads `hook_event_name` to tell SubagentStart from SubagentStop.
    const subagentBlock = [{ hooks: command }];
    hooks.SubagentStart = subagentBlock;
    hooks.SubagentStop = subagentBlock;
  }
  return JSON.stringify({ hooks }, null, 2);
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

// Install Stop + (optionally) the PreToolUse/PostToolUse activity hooks.
export async function installClaudeHooks(
  dir: string,
  urls: ClaudeHookUrls,
): Promise<void> {
  await writeStopHookFile(dir, renderClaudeHooksConfig(urls));
}

// Variant used by the prompt-customization site to invoke its backstop
// script (which posts a JSON body) instead of a bare curl.
export async function installClaudeStopHookForCommand(
  dir: string,
  command: string,
): Promise<void> {
  await writeStopHookFile(dir, renderClaudeStopHookConfigForCommand(command));
}
