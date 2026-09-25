// Graph activity for a Codex session the USER launches in an opened project —
// the sidebar "+" → Codex tab, or a Codex startup terminal — the Codex analogue
// of projectClaudeHooks.ts.
//
// A Claude session in the project tree picks up Lattice's activity hooks from
// the project's own `.claude/settings.local.json`. Codex has no such
// per-project file Lattice can merge into without touching the repo (its cwd
// `.codex/hooks.json` is a dedicated, often repo-tracked, file), so instead the
// hooks ride the launch itself: per-invocation `--config hooks.<Event>=[…]`
// inline-TOML overrides, resolved at the spawn chokepoint
// (terminalServerClient/createSession.ts) and applied by the terminal-server
// exactly like the managed MCP overrides. Nothing is written to the repo or to
// `~/.codex/config.toml`. They post to the same `/api/project-activity/:token`
// route the Claude hooks do, keyed by the hook body's `session_id` (Codex's
// hook bodies are Claude-shaped — verified against 0.157: `SessionStart`,
// `PreToolUse`/`PostToolUse` with `tool_name: "Bash"` + `tool_input.command`).
//
// Codex only runs a hook it hasn't reviewed with `--dangerously-bypass-hook-
// trust`, so the launch also gets that flag — the same one every other
// Lattice-spawned Codex already carries (agentCommandBuilder.ts). A config-layer
// `hooks.<Event>` override replaces that event's hooks from the user's
// `~/.codex/config.toml` for this session; a repo's `.codex/hooks.json` is a
// separate source and still loads.
//
// Scope: user/startup tabs only, cwd inside the project and not a Lattice
// scratch/worktree dir — task agents, workflow steps, push/QA/post-merge runs
// already get their own `.codex/hooks.json` activity hooks.

import {
  CODEX_ACTIVITY_HOOK_TIMEOUT_S,
  CODEX_ACTIVITY_TOOL_MATCHER,
  codexActivityCommands,
} from './codexStopHook.js';
import { CODEX_TUI_DEFAULTS } from './codexTerminalActivity.js';
import { isPathInsideOrSame } from './homeScratch/paths.js';
import { canonicalProjectPath } from './projectPath.js';
import { isLatticeManagedCwd } from './projectClaude/managedCwd.js';
import { projectActivityUrl } from './projectClaudeHooks.js';
import type { TerminalOwner } from './terminalRegistry/types.js';

export const CODEX_HOOK_TRUST_BYPASS_FLAG = '--dangerously-bypass-hook-trust';

const SESSION_END_TIMEOUT_S = 3;

// Whether a Codex spawn is a user-launched project session that should carry
// the project activity hooks.
export function wantsProjectCodexHooks(args: {
  cwd: string;
  projectPath: string;
  owner: TerminalOwner | undefined;
  instrumentProjectSessions: boolean | undefined;
}): boolean {
  if (args.instrumentProjectSessions === false) return false;
  // No registry hint is recorded as a plain user tab (createSession.ts).
  const owner = args.owner ?? 'user';
  if (owner !== 'user' && owner !== 'startup') return false;
  if (isLatticeManagedCwd(args.cwd)) return false;
  return isPathInsideOrSame(canonicalProjectPath(args.projectPath), args.cwd);
}

// A TOML string for `s`: a literal string ('…') when it can be one — it has no
// quote characters for cmd.exe / PowerShell to mangle on the way to codex — and
// a basic string (a JSON string is a valid one) otherwise.
function tomlString(s: string): string {
  return /['\r\n]/.test(s) ? JSON.stringify(s) : `'${s}'`;
}

// The `--config` override strings (`hooks.<Event>=[…]`, inline TOML) that
// point every activity event of this session at the project-activity route.
//
// Only this platform's command variant is emitted (a hooks.json carries both
// because it can outlive the machine that wrote it; a launch can't): the six
// overrides are expanded into the pty shell's command line, and cmd.exe caps
// that at 8191 characters alongside every managed MCP override.
export function projectCodexHookConfigArgs(
  backendOrigin: string,
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const url = projectActivityUrl(backendOrigin, canonicalProjectPath(projectPath), 'codex');
  const { posix, windows } = codexActivityCommands(url);
  const command = platform === 'win32' ? windows : posix;
  const group = (opts: { matcher?: string; timeoutS?: number } = {}) =>
    `[{${opts.matcher ? `matcher=${tomlString(opts.matcher)},` : ''}hooks=[` +
    `{type='command',command=${tomlString(command)},` +
    `timeout=${opts.timeoutS ?? CODEX_ACTIVITY_HOOK_TIMEOUT_S}}]}]`;
  return [
    // Presence: SessionEnd removes the node for good (the route's idle TTL
    // covers a hard-killed session). Codex clamps a
    // SessionEnd hook to 3 s and prints a startup warning for anything longer;
    // the curl gives up after 2 s anyway.
    `hooks.SessionStart=${group()}`,
    `hooks.SessionEnd=${group({ timeoutS: SESSION_END_TIMEOUT_S })}`,
    // Turn lifecycle: the node shows while a turn runs and is taken down
    // shortly after Stop (projectClaude/lifecycle.ts).
    `hooks.UserPromptSubmit=${group()}`,
    `hooks.Stop=${group()}`,
    // Focus beams: apply_patch edits + shell reads (decoded in hookFiles.ts).
    `hooks.PreToolUse=${group({ matcher: CODEX_ACTIVITY_TOOL_MATCHER })}`,
    `hooks.PostToolUse=${group({ matcher: CODEX_ACTIVITY_TOOL_MATCHER })}`,
    // Satellites for Codex subagents.
    `hooks.SubagentStart=${group()}`,
    `hooks.SubagentStop=${group()}`,
  ];
}

// Add `--dangerously-bypass-hook-trust` to a Codex command that lacks it,
// right after the executable (and after the TUI defaults withCodexActivityTitle
// injects there, so that rewrite stays idempotent on a relaunch).
export function withCodexHookTrustBypass(command: string): string {
  if (command.includes(CODEX_HOOK_TRUST_BYPASS_FLAG)) return command;
  const leading = /^(\s*(?:"[^"]*"|'[^']*'|\S+))/.exec(command);
  if (!leading) return command;
  let head = leading[0];
  let rest = command.slice(head.length);
  if (rest.startsWith(CODEX_TUI_DEFAULTS)) {
    head += CODEX_TUI_DEFAULTS;
    rest = rest.slice(CODEX_TUI_DEFAULTS.length);
  }
  return `${head} ${CODEX_HOOK_TRUST_BYPASS_FLAG}${rest}`;
}
