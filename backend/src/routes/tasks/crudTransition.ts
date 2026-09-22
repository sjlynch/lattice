// Lane transition + reorder handlers. Bulk status transition (by explicit
// ids or by `fromStatus` lane) and per-lane reorder.

import type { Request, Response } from 'express';
import {
  listTasks,
  reorderTasksInLane,
  updateTask,
  type TaskStatus,
} from '../../tasks.js';
import {
  isValidTaskStatus,
  partitionIdsByRequestedProject,
  requireAbsoluteProject,
  resolveProject,
  respondJson,
  statusValidationError,
} from './requestUtils.js';

export async function handleTaskTransition(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body || {}) as {
    ids?: string[];
    status?: unknown;
    fromStatus?: unknown;
  };
  const project = resolveProject(req);
  if (project && !requireAbsoluteProject(project, res)) return;
  const status = body.status;
  const fromStatus = body.fromStatus;
  if (!isValidTaskStatus(status)) {
    res.status(400).json({
      error: statusValidationError('status'),
    });
    return;
  }
  let ids: string[];
  let foreign: string[] = [];
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    // Like bulk-update's `updates[i].id`: a non-string id (`[1]`, `[null]`,
    // `[{}]`) is a malformed request, not a task that happens to be missing.
    const bad = (body.ids as unknown[]).findIndex((id) => typeof id !== 'string' || !id.trim());
    if (bad !== -1) {
      res.status(400).json({ error: `ids[${bad}] must be a non-empty string` });
      return;
    }
    // Explicit ids are a global lookup — honour the `?project=` pin (see
    // partitionIdsByRequestedProject) so a foreign id is reported, not moved.
    ({ own: ids, foreign } = await partitionIdsByRequestedProject(body.ids, req));
  } else if (fromStatus && project) {
    if (!isValidTaskStatus(fromStatus)) {
      res.status(400).json({ error: statusValidationError('fromStatus') });
      return;
    }
    const all = await listTasks(project);
    ids = all.filter((t) => t.status === fromStatus).map((t) => t.id);
  } else {
    res.status(400).json({
      error: 'provide either { ids: [...] } or { fromStatus, project }',
    });
    return;
  }
  if (ids.length === 0) {
    res.json({ updated: 0, missing: [], foreign, ids: [] });
    return;
  }
  await respondJson(res, async () => {
    const results = await Promise.all(ids.map((id) => updateTask(id, { status })));
    const updated: string[] = [];
    const missing: string[] = [];
    results.forEach((r, i) => (r ? updated.push(r.id) : missing.push(ids[i])));
    return { updated: updated.length, missing, foreign, ids: updated };
  });
}

export async function handleTaskReorder(
  req: Request,
  res: Response,
): Promise<void> {
  const { project, status, ids } = (req.body || {}) as {
    project?: string;
    status?: TaskStatus;
    ids?: string[];
  };
  if (!project || !status || !Array.isArray(ids)) {
    res.status(400).json({ error: 'project, status, ids required' });
    return;
  }
  if (!requireAbsoluteProject(project, res)) return;
  if (!isValidTaskStatus(status)) {
    res.status(400).json({ error: statusValidationError('status') });
    return;
  }
  await respondJson(res, async () => {
    const ok = await reorderTasksInLane(project, status, ids);
    if (!ok) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    return { ok: true };
  });
}
