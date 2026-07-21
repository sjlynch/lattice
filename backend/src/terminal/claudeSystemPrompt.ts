// Per-terminal Claude system-prompt override.
//
// The backend resolves the project's per-harness system-prompt override, writes
// each side to a scratch file (see harnessSystemPrompts/inject.ts), and ships
// the absolute file paths in the POST /sessions body. This rewrites a
// Lattice-started `claude` initial command to add the matching CLI flags:
//   - replaceFile → `--system-prompt-file`        (replace the built-in prompt)
//   - appendFile  → `--append-system-prompt-file`  (append to it)
// Both documented to work in interactive `claude` sessions.
//
// The file PATH (which can contain spaces / Windows backslashes) rides in a
// child-env var and the command references it via shellEnvRef — the path is
// never interpolated into shell source, mirroring codexTrust. Non-Claude
// commands and the no-override case are returned unchanged; `env` is mutated
// only when the command actually launches Claude with an override.

import { shellEnvRef } from './codexTrust.js';

export const LATTICE_CLAUDE_SYSTEM_PROMPT_FILE_ENV =
  'LATTICE_CLAUDE_SYSTEM_PROMPT_FILE';
export const LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE_ENV =
  'LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE';

const CLAUDE_COMMAND_RE = /^(\s*claude(?:\.(?:exe|cmd|ps1))?)(?=\s|$)/i;

export function configureClaudeSystemPrompt(
  initialCommand: string | undefined,
  opts: { replaceFile?: string; appendFile?: string },
  shell: string,
  env: Record<string, string>,
): string | undefined {
  if (!initialCommand) return initialCommand;
  const { replaceFile, appendFile } = opts;
  if (!replaceFile && !appendFile) return initialCommand;
  const match = CLAUDE_COMMAND_RE.exec(initialCommand);
  if (!match) return initialCommand;

  const flags: string[] = [];
  if (replaceFile) {
    env[LATTICE_CLAUDE_SYSTEM_PROMPT_FILE_ENV] = replaceFile;
    flags.push(
      `--system-prompt-file ${shellEnvRef(shell, LATTICE_CLAUDE_SYSTEM_PROMPT_FILE_ENV)}`,
    );
  }
  if (appendFile) {
    env[LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE_ENV] = appendFile;
    flags.push(
      `--append-system-prompt-file ${shellEnvRef(shell, LATTICE_CLAUDE_APPEND_SYSTEM_PROMPT_FILE_ENV)}`,
    );
  }
  const rest = initialCommand.slice(match[0].length);
  return `${match[1]} ${flags.join(' ')}${rest}`;
}
