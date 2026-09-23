// Assembles the harness command line for a workflow step. Intent-specific
// prompt text stays here; shared harness syntax (Claude permissions, Pi model
// flag, Codex prompt quoting) lives in agentCommandBuilder.ts.

import { buildAgentCommand, promptFileName, shellDoubleQuoted } from '../agentCommandBuilder.js';
import type { Workflow } from '../workflows.js';

const CLAUDE_PREFIX = 'claude --dangerously-skip-permissions ';

// A path argument for the pty's shell. On Windows (cmd.exe) backslashes are
// literal and a path can't contain `"`, so plain double quotes are exact; on
// POSIX the shared prompt-quoting rule escapes `"`, `\`, `$` and backticks.
function quotePathArg(p: string): string {
  return process.platform === 'win32' ? `"${p}"` : shellDoubleQuoted(p);
}

export function buildWorkflowStepCommand(
  stepFile: string,
  harness: Workflow['steps'][number]['harness'],
  piModel?: string,
  codexYolo?: boolean,
  // Claude only: an extra working directory (`--add-dir`). The Run tests step
  // runs from its step dir but works in the project, so the project is added
  // — otherwise Claude's Bash tool resets a `cd` outside the session cwd.
  // Emitted in the `--add-dir=<path>` form: the flag is variadic, and with a
  // separate value it would swallow the trailing prompt as a second directory.
  opts: { claudeAddDir?: string } = {},
): string {
  const resolvedHarness = harness ?? 'claude';
  const fileName = promptFileName(stepFile);
  const command = buildAgentCommand({
    harness: resolvedHarness,
    piModel,
    codexYolo,
    prompt: `Please read ${fileName} and complete the task described in it.`,
  });
  if (resolvedHarness === 'claude' && opts.claudeAddDir && command.startsWith(CLAUDE_PREFIX)) {
    return `${CLAUDE_PREFIX}--add-dir=${quotePathArg(opts.claudeAddDir)} ${command.slice(CLAUDE_PREFIX.length)}`;
  }
  return command;
}
