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
  resolveProject,
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
  const status = body.status;
  const fromStatus = body.fromStatus;
  if (!isValidTaskStatus(status)) {
    res.status(400).json({
      error: statusValidationError('status'),
    });
    return;
  }
  let ids: string[];
  if (Array.isArray(body.ids) && body.ids.length > 0) {
    ids = body.ids;
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
    res.json({ updated: 0, missing: [], ids: [] });
    return;
  }
  try {
    const results = await Promise.all(ids.map((id) => updateTask(id, { status })));
    const updated: string[] = [];
    const missing: string[] = [];
    results.forEach((r, i) => (r ? updated.push(r.id) : missing.push(ids[i])));
    res.json({ updated: updated.length, missing, ids: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
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
  try {
    const ok = await reorderTasksInLane(project, status, ids);
    if (!ok) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
