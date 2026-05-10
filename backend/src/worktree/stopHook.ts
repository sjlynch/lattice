import path from 'node:path';
import fs from 'node:fs/promises';
import {
  installClaudeStopHook,
  renderClaudeStopHookConfig,
} from '../claudeStopHook.js';

// Write patterns to the worktree-local git exclude file so these files
// are invisible to `git status` inside the worktree. The exclude file
// lives in the worktree's gitdir (resolved from the .git pointer file)
// and is never committed — unlike .gitignore which is part of the tree.
export async function writeWorktreeExclude(worktreePath: string, patterns: string[]): Promise<void> {
  try {
    const gitPointer = await fs.readFile(path.join(worktreePath, '.git'), 'utf8');
    const gitDirRelative = gitPointer.trim().replace(/^gitdir:\s*/i, '');
    const gitDir = path.resolve(worktreePath, gitDirRelative);
    const infoDir = path.join(gitDir, 'info');
    await fs.mkdir(infoDir, { recursive: true });
    await fs.appendFile(
      path.join(infoDir, 'exclude'),
      `\n# Lattice-managed — do not commit\n${patterns.join('\n')}\n`,
      'utf8',
    );
  } catch (err) {
    // Non-fatal: the merge path already handles the shelve-and-restore
    // fallback; this is belt-and-suspenders prevention only.
    console.warn('[worktree] could not write local exclude file:', err);
  }
}

// Claude hook config — Stop hook posts back so the task moves to QA.
// Written into <worktree>/.claude/settings.local.json so it's scoped to
// just that worktree's Claude session.
//
// Exported as `renderStopHookJson` so the validation/repair path in the
// merge route can rebuild the file from the same template Lattice uses
// at setup time.
export function renderStopHookJson(taskId: string, backendOrigin: string): string {
  return renderClaudeStopHookConfig(
    `${backendOrigin}/api/tasks/${taskId}/complete`,
  );
}

export async function installStopHook(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  await installClaudeStopHook(
    worktreePath,
    `${backendOrigin}/api/tasks/${taskId}/complete`,
  );
}

// Pi has no settings-driven command hooks (it's deliberately minimal — no
// MCP, no permission popups, no command hooks). What it does have is a
// TypeScript extension system: any `*.ts` under `<cwd>/.pi/extensions/` is
// auto-loaded — no settings.json entry needed — and runs in Node, so it can
// `fetch()` the same `/complete` callback the Claude Stop hook curls.
//
// We gate on `event.reason === 'quit'` so an in-session `/new`, `/reload`,
// or `/fork` (which also emit `session_shutdown`) doesn't flip the task
// early. Even if it did, `/complete` is idempotent and only advances a task
// that has commits — but flipping also schedules a 1s pty kill, which we
// don't want yanked out from under an interactive user.
//
// This is a backstop: LATTICE_TASK.md already tells the Pi model to POST
// `/complete` itself as its final step. The extension covers the case where
// the model errors out or forgets. Both calls landing is harmless.
export function renderPiCompletionExtension(taskId: string, backendOrigin: string): string {
  const url = `${backendOrigin}/api/tasks/${taskId}/complete`;
  return `// Lattice-managed — do not commit. Reports task completion to Lattice when
// the Pi session exits, mirroring the Claude Stop hook in
// .claude/settings.local.json.
export default function (pi) {
  pi.on("session_shutdown", async (event) => {
    if (event && event.reason && event.reason !== "quit") return;
    try {
      await fetch(${JSON.stringify(url)}, { method: "POST" });
    } catch {
      // best-effort, same as the curl-based Stop hook
    }
  });
}
`;
}

export async function installPiCompletionExtension(
  worktreePath: string,
  taskId: string,
  backendOrigin: string,
): Promise<void> {
  const extDir = path.join(worktreePath, '.pi', 'extensions');
  await fs.mkdir(extDir, { recursive: true });
  const file = path.join(extDir, 'lattice-complete.ts');
  const expected = renderPiCompletionExtension(taskId, backendOrigin);
  // Skip rewrite if it already matches — keeps `git status` clean when the
  // worktree is reconciled and recreated against the same task.
  try {
    const existing = await fs.readFile(file, 'utf8');
    if (existing === expected) return;
  } catch {
    /* file absent — fall through to write */
  }
  await fs.writeFile(file, expected, 'utf8');
}
