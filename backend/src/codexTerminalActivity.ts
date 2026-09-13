import { agentHarnessForCommand } from './harnesses.js';

// The Codex welcome screen can animate indefinitely at an empty prompt. Its
// explicit TUI status distinguishes that animation from a running turn. This
// is a per-invocation default, never a write to the user's Codex configuration.
// Double-quoted shell argument + TOML literal string works in cmd/PowerShell
// and POSIX shells without interpolation. User-supplied later overrides win.
const TITLE_CONFIG = ' --config "tui.terminal_title=[\'status\']"';

export function withCodexActivityTitle(command: string | undefined): string | undefined {
  if (agentHarnessForCommand(command) !== 'codex' || !command) return command;
  const leading = /^(\s*(?:"[^"]*"|'[^']*'|\S+))/.exec(command);
  if (!leading) return command;
  if (command.slice(leading[0].length).startsWith(TITLE_CONFIG)) return command;
  return leading[0] + TITLE_CONFIG + command.slice(leading[0].length);
}

// Exact status-only titles from Codex 0.154: Ready when waiting for a prompt,
// Working during the turn, and Ready after completion/error/interrupt.
// Unknown/custom/disabled titles must never fall back to animated output.
export function codexTitleIsWorking(title: unknown): boolean {
  return title === 'Working';
}
