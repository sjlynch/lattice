import path from 'node:path';
import fs from 'node:fs/promises';

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

export function renderCodexStopHookJson(callbackUrl: string): string {
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
  // curl ships with Windows 10+ and every POSIX box, and the /complete endpoints
  // reply fast with a tiny body (`-s -m 5`, mirroring the Claude Stop hook).
  const posix = `curl -s -m 5 -X POST ${callbackUrl}`;
  const config = {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: posix,
              commandWindows: `cmd /c ${posix}`,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(config, null, 2);
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
export async function installCodexStopHook(
  dir: string,
  callbackUrl: string,
  policy: CodexHookOverwritePolicy = 'always',
): Promise<boolean> {
  const file = codexHooksJsonPath(dir);
  const expected = renderCodexStopHookJson(callbackUrl);
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
  } catch {
    /* absent — fall through to write */
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, expected, 'utf8');
  return true;
}
