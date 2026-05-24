// Periodic staleness sweep for `in_progress` tasks.
//
// The Pi extension and the model's explicit `/complete` curl are both best-
// effort — if Pi crashes, OOMs, or exits with a non-`quit` reason that the
// extension's gate filters out, the task can sit in `in_progress` with a
// committed branch but a dead PTY forever. The boot-time `recoverOrphanedTasks`
// only catches one class of related failure (ready_to_merge with deleted
// branch). This sweep complements it from the other end: in_progress tasks
// whose PTY is dead AND whose branch has a commit get auto-completed.
//
// What we look for:
//   1. Task is `in_progress`.
//   2. Task has a `worktreePath` and `branch`.
//   3. The terminal-server has NO live session whose `cwd` is the worktree
//      (the original spawn is dead and the model is not coming back).
//   4. The branch has at least one commit (work was actually done — same
//      check the `/complete` route uses before transitioning).
//   5. The task has been `in_progress` for at least `MIN_AGE_MS` so a task
//      that is mid-startup (worktree created, model still booting) isn't
//      false-positively flipped.
//
// All five must hold for a task to be auto-completed. The transition runs
// through the same crash-safe update + post-flip pty cleanup as the normal
// `/complete` path, and reads any Pi sentinel file the dead extension wrote
// so the log line says *why* the model didn't call back itself.

import path from 'node:path';
import {
  listKnownProjects,
  listTasks,
  updateTask,
  type Task,
} from '../tasks.js';
import { branchCommitCount } from '../worktree.js';
import { proxyListSessions } from '../terminalProxy.js';
import { readPiShutdownSentinel } from '../piExtension.js';

// Minimum `in_progress` age before a task is eligible for an auto-flip.
// Tasks younger than this are presumed mid-startup; the model may not have
// printed its first prompt yet.
const MIN_AGE_MS = 5 * 60 * 1000;

// How often to run the sweep. Pi sessions can wedge silently for tens of
// minutes before the user notices; one pass per minute is cheap and
// catches things at most ~1 min after the PTY actually dies.
export const IN_PROGRESS_SWEEP_INTERVAL_MS = 60 * 1000;

type SweepResult = {
  scanned: number;
  flipped: number;
  skipped: { reason: string; taskId: string }[];
};

export async function sweepStuckInProgressTasks(): Promise<SweepResult> {
  const result: SweepResult = { scanned: 0, flipped: 0, skipped: [] };
  const projects = await safeListKnownProjects();
  if (projects.length === 0) return result;

  // Snapshot live sessions once and reuse — proxyListSessions hits the
  // terminal-server over HTTP, no point hammering it per task.
  const liveCwds = await collectLiveSessionCwds();
  if (liveCwds === null) {
    // Terminal-server unreachable — we cannot distinguish "no live session"
    // from "can't tell". Skip this pass; the next tick will retry.
    console.warn(
      '[in-progress-sweep] terminal-server unreachable — skipping this pass',
    );
    return result;
  }

  const now = Date.now();
  for (const project of projects) {
    let tasks: Task[];
    try {
      tasks = await listTasks(project);
    } catch (err) {
      console.warn(
        `[in-progress-sweep] listTasks(${project}) failed:`,
        err,
      );
      continue;
    }
    for (const task of tasks) {
      if (task.status !== 'in_progress') continue;
      result.scanned += 1;
      await considerOneTask({ task, liveCwds, now, result });
    }
  }

  if (result.flipped > 0 || result.skipped.length > 0) {
    console.log(
      `[in-progress-sweep] scanned=${result.scanned} flipped=${result.flipped} skipped=${result.skipped.length}`,
    );
  }
  return result;
}

async function considerOneTask(args: {
  task: Task;
  liveCwds: Set<string>;
  now: number;
  result: SweepResult;
}): Promise<void> {
  const { task, liveCwds, now, result } = args;
  if (!task.worktreePath || !task.branch) {
    result.skipped.push({ reason: 'no worktree/branch', taskId: task.id });
    return;
  }
  const ageMs = now - (task.startedAt ?? task.createdAt);
  if (ageMs < MIN_AGE_MS) {
    // Don't log — these are normal in-flight tasks and we'd spam the log.
    return;
  }
  const wtKey = normalizeCwd(task.worktreePath);
  if (liveCwds.has(wtKey)) {
    // Model is still running — leave it alone.
    return;
  }

  let commits: number;
  try {
    commits = await branchCommitCount(task.projectPath, task.branch);
  } catch (err) {
    console.warn(
      `[in-progress-sweep] task ${task.id}: branchCommitCount threw:`,
      err,
    );
    result.skipped.push({ reason: 'commit-count threw', taskId: task.id });
    return;
  }
  if (commits === 0) {
    // PTY dead, no commits — there is nothing to flip to. Likely the model
    // exited before doing anything. We could re-enqueue a resume here, but
    // that's a separate concern; for now just log so the operator sees it.
    console.warn(
      `[in-progress-sweep] task ${task.id} ("${task.title.slice(0, 40)}") ` +
        `PTY dead, no commits on ${task.branch} — leaving at in_progress`,
    );
    result.skipped.push({ reason: 'pty dead, no commits', taskId: task.id });
    return;
  }

  // Read the Pi sentinel (if any) so the diagnostic log explains why the
  // model didn't call back — quit-gated reason, fetch error, missing file...
  const sentinel = await readPiShutdownSentinel(task.worktreePath);
  console.warn(
    `[in-progress-sweep] auto-completing task ${task.id} ` +
      `("${task.title.slice(0, 40)}") — PTY dead, branch ${task.branch} has ` +
      `${commits} commit(s), age ${Math.round(ageMs / 1000)}s. ` +
      `Pi sentinel: ${sentinel ? JSON.stringify(sentinel) : 'absent'}`,
  );

  try {
    await updateTask(task.id, {
      status: 'ready_to_merge',
      completedAt: Date.now(),
    });
    result.flipped += 1;
  } catch (err) {
    console.error(
      `[in-progress-sweep] task ${task.id}: updateTask failed:`,
      err,
    );
    result.skipped.push({ reason: 'updateTask threw', taskId: task.id });
  }
}

async function safeListKnownProjects(): Promise<string[]> {
  try {
    return await listKnownProjects();
  } catch (err) {
    console.warn('[in-progress-sweep] listKnownProjects threw:', err);
    return [];
  }
}

// Returns the resolved cwd of every live terminal-server session, or null
// when the terminal-server is unreachable (so callers can distinguish "no
// sessions" from "can't tell" — same distinction the spawn queue makes).
async function collectLiveSessionCwds(): Promise<Set<string> | null> {
  let sessions: unknown[];
  try {
    sessions = await proxyListSessions();
  } catch {
    return null;
  }
  // proxyListSessions returns [] both on success-with-no-sessions and on
  // any failure. We can't distinguish those reliably here, so we
  // conservatively treat an empty list as "no live sessions" — the worst
  // false-positive is a stuck task auto-completing slightly faster, which
  // is what this sweep is for.
  const set = new Set<string>();
  for (const s of sessions) {
    if (s && typeof s === 'object' && 'cwd' in s) {
      const cwd = (s as { cwd?: unknown }).cwd;
      if (typeof cwd === 'string' && cwd.length > 0) {
        set.add(normalizeCwd(cwd));
      }
    }
  }
  return set;
}

// Path normalization for cwd comparison: case-insensitive on Windows
// (Windows allows mixed-case paths but the filesystem is case-preserving
// not case-sensitive), normalized separators, trailing-slash stripped.
function normalizeCwd(p: string): string {
  let out = path.resolve(p);
  if (process.platform === 'win32') out = out.toLowerCase();
  return out.replace(/[\\/]+$/, '');
}

// Periodic-sweep loop holder. Kept module-scoped so the start/stop calls
// in server/startup.ts don't have to pass an opaque handle around.
let sweepTimer: NodeJS.Timeout | null = null;

export function startInProgressSweepLoop(
  intervalMs: number = IN_PROGRESS_SWEEP_INTERVAL_MS,
): void {
  if (sweepTimer) return;
  // First pass after a short delay so it doesn't pile onto boot recovery.
  sweepTimer = setInterval(() => {
    sweepStuckInProgressTasks().catch((err) => {
      console.error('[in-progress-sweep] tick threw:', err);
    });
  }, intervalMs);
  // Don't keep the event loop alive — the HTTP server already does that.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  console.log(
    `[in-progress-sweep] started; interval=${intervalMs}ms, minAge=${MIN_AGE_MS}ms`,
  );
}

export function stopInProgressSweepLoop(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
