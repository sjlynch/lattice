import path from 'node:path';
import fs from 'node:fs/promises';
import { atomicWriteFile } from './claudeTrust/configFile.js';
import {
  CALLBACK_HOOK_TIMEOUT_S,
  codexCallbackCommands,
  ensureCallbackScript,
} from './callbackOutbox/script.js';

// Codex Stop hook — the Codex analogue of the Claude Stop hook
// (claudeStopHook.ts) and the Pi `session_shutdown` completion extension
// (piExtension.ts).
//
// Codex (>= 0.144) ships a Claude-style hooks framework. Its `Stop` event fires
// ONCE when the agent's turn completes (verified against 0.144.1 — and, unlike
// Claude's `Stop`, it does NOT fire early/repeatedly around subagents, so no
// quiescence gate is needed here). Registering a `Stop` hook that POSTs the
// completion callback makes a Codex step/task advance reliably even when the
// model forgets to curl `/complete` itself — WITHOUT switching to headless
// `codex exec`, so interactive steering of the session is preserved.
//
// Injection is a cwd-local `<cwd>/.codex/hooks.json`: Codex auto-discovers hooks
// there relative to the session cwd (confirmed even when cwd is a *subdirectory*
// of the git root — i.e. a workflow-step scratch dir). `hooks.json` is a
// DEDICATED hooks file, so it coexists with a repo's own `.codex/config.toml`
// (the lowest-collision slot). The Lattice-spawned codex command carries
// `--dangerously-bypass-hook-trust` (see agentCommandBuilder.ts) so this
// non-managed hook runs without Codex's per-hook trust prompt — consistent with
// Lattice already running codex `--yolo` (full-auto) for its own sessions.

// Codex tool names whose hooks can name a file (hookFiles.ts decodes them):
// `apply_patch` (edits — every file is on a patch header) and the shell
// (reads — Codex has no read tool). The matcher is a regex on `tool_name`.
export const CODEX_ACTIVITY_TOOL_MATCHER = 'Bash|apply_patch|shell|exec_command';

// Seconds Codex may wait on one activity hook. The curl itself gives up after
// 2 s; a PreToolUse hook runs before the tool does, so it must stay short.
export const CODEX_ACTIVITY_HOOK_TIMEOUT_S = 5;

// The activity hook command: forward the hook JSON Codex writes to the hook's
// stdin as the POST body (`-d@-`), like the Claude activity hook. It must parse
// identically however Codex runs it: 0.144 spawned the whitespace-split argv
// directly (the Stop hook notes below), but 0.157 runs a hook command through
// Windows PowerShell 5.1 — verified: a `$PSVersionTable` hook resolves and `>`
// writes UTF-16. So no quotes (the header is one whitespace-free token), and
// NOT `--data-binary @-`: PowerShell rejects a bare `@-` as a splatting parse
// error, the hook "Failed" before curl ever started, and no Codex session drew
// a single beam. `-d@-` is one plain token to PowerShell, cmd, sh and a direct
// spawn alike (`-d` drops CR/LF, which JSON only has between tokens). `cmd /c`
// on Windows so curl.exe resolves — under PowerShell 5.1 a bare `curl` is the
// Invoke-WebRequest alias. The endpoint answers 204 with no body and `-s`
// silences errors, so the hook prints nothing: Codex parses a PreToolUse
// hook's stdout as a decision, and empty output is "no opinion". curl never
// exits 2 (Codex's "block the tool" code) on a failed POST, so a down backend
// never blocks a tool call.
export function codexActivityCommands(activityUrl: string): { posix: string; windows: string } {
  const posix =
    `curl -s -m 2 -X POST -H Content-Type:application/json -d@- ${activityUrl}`;
  return { posix, windows: `cmd /c ${posix}` };
}

export function renderCodexStopHookJson(callbackUrl: string, activityUrl?: string): string {
  // IMPORTANT: Codex runs a hook `command` by whitespace-splitting it and
  // spawning the argv DIRECTLY — no shell (verified against 0.144.1 on Windows).
  // Two consequences shape this renderer:
  //   1. The URL is left UNQUOTED. With no shell there is nothing to strip the
  //      quotes, so `"<url>"` would reach curl as a literal argument (quotes
  //      included) and the request would fail. Our completion URLs carry no
  //      shell/cmd metacharacters (a single `?source=<slug>` param, never `&`),
  //      exactly like the Claude Stop hook's unquoted curl.
  //   2. On Windows a bare `curl` argv0 fails to spawn this way, so the Windows
  //      variant wraps it in `cmd /c` (which resolves + runs curl.exe). On POSIX
  //      a bare `curl` direct-spawn works. `commandWindows` is the JSON key
  //      (camelCase; the TOML equivalent is `command_windows`), and Codex prefers
  //      it on win32 — verified end-to-end (the POST reaches the endpoint).
  // The command runs the durable callback script (outbox + retries, see
  // callbackOutbox/script.ts) — the same delivery the Claude Stop hook uses,
  // so a Stop that lands while the backend is restarting is replayed rather
  // than lost. `node` is resolved the same way `curl` was (bare on POSIX,
  // through `cmd /c` on Windows); a script path containing whitespace can't
  // survive the whitespace split, so that case falls back to a retrying curl.
  const { posix, windows } = codexCallbackCommands(callbackUrl);
  const hooks: Record<string, unknown[]> = {
    Stop: [
      {
        hooks: [
          {
            type: 'command',
            command: posix,
            commandWindows: windows,
            timeout: CALLBACK_HOOK_TIMEOUT_S,
          },
        ],
      },
    ],
  };
  if (activityUrl) {
    // Graph activity (the agent node's focus beams + file label), the Codex
    // analogue of the Claude PreToolUse/PostToolUse/SubagentStart/SubagentStop
    // hooks in claudeStopHook.ts. Codex (>= 0.15x) fires all four with a
    // Claude-shaped body (`tool_name`/`tool_input`, and `agent_id`/`agent_type`
    // from inside a subagent), so the same activity routes decode them.
    const activity = codexActivityCommands(activityUrl);
    const command = [
      {
        type: 'command',
        command: activity.posix,
        commandWindows: activity.windows,
        timeout: CODEX_ACTIVITY_HOOK_TIMEOUT_S,
      },
    ];
    const toolBlock = [{ matcher: CODEX_ACTIVITY_TOOL_MATCHER, hooks: command }];
    hooks.PreToolUse = toolBlock;
    hooks.PostToolUse = toolBlock;
    const subagentBlock = [{ hooks: command }];
    hooks.SubagentStart = subagentBlock;
    hooks.SubagentStop = subagentBlock;
  }
  return JSON.stringify({ hooks }, null, 2);
}

export function codexHooksJsonPath(dir: string): string {
  return path.join(dir, '.codex', 'hooks.json');
}

export type CodexHookOverwritePolicy = 'always' | 'if-absent';

// Does this `.codex/hooks.json` look like one LATTICE wrote (for some other
// task/run), rather than one the repo owns?
//
// This matters because `if-absent` protects the repo's file, and a
// Lattice-generated hooks.json can END UP tracked on main: an agent commits it
// (`git add -A` in a worktree older than the exclude pattern, a codex session
// committing its own `.codex/`), the merge carries it to main, and from then on
// every fresh worktree checks it out. `if-absent` would then leave a Stop hook
// pointing at a COMPLETED task's `/complete` URL — worse than no backstop,
// since it reports the wrong task finished. A file we can positively identify
// as ours is stale by definition (the URL is per-task/per-run), so rewrite it.
//
// Deliberately narrow: it must contain a command targeting one of Lattice's own
// completion endpoints. A repo's genuine hooks file won't.
const LATTICE_CALLBACK_RE =
  /\/api\/(?:tasks\/[^\s"']+\/complete|workflow-runs\/[^\s"']+\/complete|post-merge-hooks\/[^\s"']+\/complete)/;

export function isLatticeGeneratedCodexHooks(contents: string): boolean {
  return LATTICE_CALLBACK_RE.test(contents);
}

// Install the Stop hook into `<dir>/.codex/hooks.json`.
//
// `policy`:
//   - 'always'    — write unconditionally. Use for fresh Lattice-owned scratch
//                   cwds (workflow steps, post-merge hooks) that can't collide
//                   with a repo file.
//   - 'if-absent' — write only when no `.codex/hooks.json` exists yet. Use for
//                   task worktrees: the file could be one the REPO tracks, and
//                   clobbering it would lose the user's hooks + dirty the tree.
//                   Returns false when it skips (the caller logs and falls back
//                   to the model's explicit `/complete` curl).
//
// Idempotent: an existing file that already matches ours is left untouched
// (keeps `git status` clean when a worktree is reconciled + recreated against
// the same task).
//
// `activityUrl` (optional) adds the graph-activity hooks alongside the Stop
// hook — the task `/activity` route or a non-worktree `/api/agent-activity/…`
// token URL.
export async function installCodexStopHook(
  dir: string,
  callbackUrl: string,
  policy: CodexHookOverwritePolicy = 'always',
  activityUrl?: string,
): Promise<boolean> {
  const file = codexHooksJsonPath(dir);
  const expected = renderCodexStopHookJson(callbackUrl, activityUrl);
  ensureCallbackScript();
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (existing === expected) return true; // already ours — no-op
    if (policy === 'if-absent' && !isLatticeGeneratedCodexHooks(existing)) {
      return false; // a repo-owned file — don't clobber
    }
    if (policy === 'if-absent') {
      console.warn(
        `[codex-hook] replacing a stale Lattice-generated ${file} (it targets ` +
          `another task's completion URL)`,
      );
    }
  } catch (err) {
    // Only ENOENT means absent. Any other read error (EBUSY/EPERM/EACCES — on
    // Windows an antivirus scan or an editor briefly holding the file) means a
    // file we can't see is there: under 'if-absent' it may be the repo's own
    // hooks.json, so don't write over it.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT' && policy === 'if-absent') {
      console.warn(`[codex-hook] could not read ${file} (${code ?? err}); not overwriting it`);
      return false;
    }
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWriteFile(file, expected);
  return true;
}
