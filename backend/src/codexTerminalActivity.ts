import { agentHarnessForCommand } from './harnesses.js';

// The Codex welcome screen can animate indefinitely at an empty prompt. Its
// explicit TUI status distinguishes that animation from a running turn. This
// is a per-invocation default, never a write to the user's Codex configuration.
// Double-quoted shell argument + TOML literal string works in cmd/PowerShell
// and POSIX shells without interpolation. User-supplied later overrides win.
const TITLE_CONFIG = ' --config "tui.terminal_title=[\'status\']"';

// Codex's TUI (openai/codex#18575, always-on — its feature flag has since
// been removed) reacts to EVERY terminal width change by clearing its
// scrollback and re-emitting the transcript, capped at
// `tui.terminal_resize_reflow_max_rows` newest rows. The cap is picked per
// detected terminal, and a Codex spawned from Lattice inherits the dev
// server's environment — under Windows Terminal that is `WT_SESSION`, which
// selects a 9001-row cap. Re-emitting up to nine thousand rows through the
// pty → relay → xterm on each resize is the "Codex writes out all its past
// text for minutes" symptom. A Lattice pane is a scrolling xterm with its own
// 20 000-line buffer, so a much smaller cap loses little: only what a resize
// keeps of the OLDER transcript in xterm's scrollback (Ctrl+T in Codex still
// pages the whole transcript). The frontend also debounces resizes so a drag
// costs one reflow instead of one per pixel.
export const CODEX_RESIZE_REFLOW_MAX_ROWS = 500;
const REFLOW_CONFIG = ` --config "tui.terminal_resize_reflow_max_rows=${CODEX_RESIZE_REFLOW_MAX_ROWS}"`;

// Both defaults, in the order they are injected right after the executable.
export const CODEX_TUI_DEFAULTS = TITLE_CONFIG + REFLOW_CONFIG;

export function withCodexActivityTitle(command: string | undefined): string | undefined {
  if (agentHarnessForCommand(command) !== 'codex' || !command) return command;
  const leading = /^(\s*(?:"[^"]*"|'[^']*'|\S+))/.exec(command);
  if (!leading) return command;
  const rest = command.slice(leading[0].length);
  if (rest.startsWith(CODEX_TUI_DEFAULTS)) return command;
  // A command carrying only the older title default (a record launched before
  // the reflow cap existed, relaunched by the registry restore) gains the cap.
  if (rest.startsWith(TITLE_CONFIG)) {
    return leading[0] + CODEX_TUI_DEFAULTS + rest.slice(TITLE_CONFIG.length);
  }
  return leading[0] + CODEX_TUI_DEFAULTS + rest;
}

// Exact status-only titles from Codex 0.154: Ready when waiting for a prompt,
// Working during the turn, and Ready after completion/error/interrupt.
// Unknown/custom/disabled titles must never fall back to animated output.
export function codexTitleIsWorking(title: unknown): boolean {
  return title === 'Working';
}
