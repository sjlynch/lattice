// Guard against phantom-project task creation.
//
// `canonicalProjectPath` runs `path.resolve()`, which silently turns a
// mangled or relative project string into a plausible-but-wrong ABSOLUTE
// path rooted at the backend's cwd (`C:\development\lattice\backend`). That is
// the exact trap that lands a task on `C:\development\lattice\backend\<garbage>`
// when a shell eats the backslashes out of `C:\development\<garbage>` — the
// caller thinks they hit their project's board, but a brand-new phantom
// project is silently born (and permanently indexed in ~/.lattice/projects.json).
//
// Every legitimate caller (the UI folder picker, the generated
// `create-task.cjs` helper) sends an absolute path to an existing git repo, so
// we require exactly that before a *new* task can be created. This mirrors the
// `/api/push-runs` git-repo gate — a task that isn't rooted in a git repo can
// never spawn a worktree or merge anyway, so rejecting at create time just
// surfaces the failure earlier, with a message that names the likely cause.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { canonicalProjectPath } from '../../projectPath.js';

export type ProjectValidation =
  | { ok: true; canonical: string }
  | { ok: false; error: string };

function notGitError(canonical: string): string {
  return (
    `project is not a git repository — no .git found at ${JSON.stringify(canonical)}. ` +
    `Lattice tasks run in git worktrees, so the project must be a git repo root.`
  );
}

// Validate a `project` string that is about to CREATE a task (single create,
// batch create, or an upsert that may create). Returns the canonical path on
// success, or a human-readable reason on failure (rendered as an HTTP 400).
export async function validateProjectForCreate(
  project: string | null | undefined,
): Promise<ProjectValidation> {
  const raw = (project ?? '').trim();
  if (!raw) return { ok: false, error: 'project is required' };

  // A relative or drive-relative path (`C:foo`, `foo\bar`) is almost always
  // shell-escaping damage. path.resolve would happily invent an absolute path
  // for it; refuse instead so the mistake is loud rather than silent.
  if (!path.isAbsolute(raw)) {
    return {
      ok: false,
      error:
        `project must be an absolute path, got ${JSON.stringify(raw)}. ` +
        `A relative or drive-relative path here almost always means backslashes ` +
        `were stripped by shell escaping (e.g. C:\\development\\proj arriving as ` +
        `"C:developmentproj"). Pass the full absolute path — ideally from a script ` +
        `file as a string literal rather than an inline shell argument.`,
    };
  }

  const canonical = canonicalProjectPath(raw);

  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(canonical);
  } catch {
    return {
      ok: false,
      error:
        `project path does not exist: ${JSON.stringify(canonical)}. ` +
        `Refusing to create a task for a non-existent project — a mangled path ` +
        `commonly resolves to a directory that was never a real project.`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: `project path is not a directory: ${JSON.stringify(canonical)}.`,
    };
  }

  // `.git` can be a directory (normal repo) or a file (worktree checkout /
  // submodule), matching the /api/push-runs and /api/git-check probes.
  try {
    const gitStat = await fsp.stat(path.join(canonical, '.git'));
    if (!gitStat.isDirectory() && !gitStat.isFile()) {
      return { ok: false, error: notGitError(canonical) };
    }
  } catch {
    return { ok: false, error: notGitError(canonical) };
  }

  return { ok: true, canonical };
}
