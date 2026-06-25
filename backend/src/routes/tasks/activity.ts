// POST /api/tasks/:id/activity — the Claude PreToolUse/PostToolUse hook
// callback for the 3D graph's focus beam. Maps the worktree file the agent is
// touching back to a project-absolute path and emits a `task-activity` event.
//
// Read-only against the disposable worktree, so nothing here can touch the
// project repo. The sibling `GET /api/tasks/worktree-modified` (git diff/status
// polling + caching) lives in `worktreeModified.ts`; the `isManaged` filter
// stays here because the non-worktree agent-activity route imports it.

import path from 'node:path';
import { Router } from 'express';
import { getTask, type Task } from '../../tasks.js';
import { canonicalProjectPath } from '../../projectPath.js';
import { LATTICE_OWNED_FILE_PATHS } from '../../worktree/managedFiles.js';
import { decodeActivityHook } from '../../activityHook.js';
import { notifyTaskActivity } from '../../taskActivityEvents.js';

// Repo-relative paths Lattice owns inside a worktree — never a real edit the
// graph should beam to. Compared with forward-slash normalization.
const MANAGED_REL = new Set<string>(
  LATTICE_OWNED_FILE_PATHS.map((p) => p.replace(/\\/g, '/')),
);

// A Lattice-managed file (or scratch path) the graph should never beam to.
// Exported for the non-worktree agent-activity route (and the worktree-modified
// route), which also drop edits under `.lattice/`.
export function isManaged(rel: string): boolean {
  const norm = rel.replace(/\\/g, '/');
  if (MANAGED_REL.has(norm)) return true;
  // Anything under our scratch dirs.
  return (
    norm.startsWith('.claude/') ||
    norm.startsWith('.pi/') ||
    norm.startsWith('.lattice/') ||
    /^STASH_CONFLICT_[A-Za-z0-9_-]+\.md$/.test(norm)
  );
}

// Map a worktree-absolute (or worktree-relative) file path to the matching
// project-absolute path the scanner emits as `node.path`. Returns null if the
// path escapes the worktree or is a Lattice-managed file.
function mapWorktreeFileToProject(task: Task, rawFile: string): string | null {
  if (!task.worktreePath) return null;
  const abs = path.isAbsolute(rawFile)
    ? rawFile
    : path.resolve(task.worktreePath, rawFile);
  const rel = path.relative(task.worktreePath, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (isManaged(rel)) return null;
  // The scanner roots node paths at canonicalProjectPath(root); match that so
  // the frontend lookup hits.
  return path.join(canonicalProjectPath(task.projectPath), rel);
}

export function buildTaskActivityRouter(): Router {
  const r = Router();

  r.post('/api/tasks/:id/activity', async (req, res) => {
    // Always 204 — the worktree agent's curl ignores the body, and a hook
    // must never surface an error back into the agent's tool call.
    const ack = () => res.status(204).end();
    let task: Task | null | undefined;
    try {
      task = await getTask(req.params.id);
    } catch {
      return ack();
    }
    if (!task || !task.worktreePath) return ack();
    const t = task; // narrow for the mapFile closure below

    // Shared decode (the SubagentStart/Stop satellite branch + phase/tool/
    // subagent extraction); only the worktree file-mapping is task-specific.
    const result = decodeActivityHook(req.body, (raw) =>
      mapWorktreeFileToProject(t, raw),
    );
    if (!result) return ack();

    if (result.kind === 'lifecycle') {
      // A satellite node appears/disappears around the task's Claude node.
      notifyTaskActivity({
        projectPath: t.projectPath,
        taskId: t.id,
        phase: 'start',
        tool: 'Task',
        ts: Date.now(),
        subagentId: result.subagentId,
        subagentType: result.subagentType,
        lifecycle: result.lifecycle,
      });
      return ack();
    }

    // A subagent's own tool-use carries `subagentId`; tagging the event routes
    // the focus beam to that satellite instead of the main Claude node.
    notifyTaskActivity({
      projectPath: t.projectPath,
      taskId: t.id,
      file: result.file,
      phase: result.phase,
      tool: result.tool,
      ts: Date.now(),
      subagentId: result.subagentId,
      subagentType: result.subagentType,
    });
    return ack();
  });

  return r;
}
