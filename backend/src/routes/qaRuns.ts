// QA e2e-run lifecycle: spawn a Playwright-enabled Claude session (from
// home-scoped scratch) that exercises a merged QA-lane task end-to-end, then
// closes itself when Claude stops (via a settings.local.json Stop hook). The
// QA-lane Playwright toggle must be on for the project, or the Playwright MCP
// won't be injected — the frontend only surfaces the buttons in that case.

import { Router } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import { getTask } from '../tasks.js';
import {
  cleanupQaSession,
  forgetQaRun,
  getQaRun,
  markQaRunDone,
  qaAgentId,
  startQaSession,
} from '../qaRuns.js';
import { unregisterAgentSession } from '../agentSessions.js';

export function buildQaRunsRouter(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/qa-runs', async (req, res) => {
    const body = (req.body || {}) as { project?: string; taskId?: string };
    if (!body.project) return res.status(400).json({ error: 'project required' });
    if (!body.taskId) return res.status(400).json({ error: 'taskId required' });
    const project = canonicalProjectPath(body.project);

    const task = await getTask(body.taskId);
    if (!task) return res.status(404).json({ error: 'task not found' });
    // Defensive: a QA run only makes sense against the task's own project.
    if (canonicalProjectPath(task.projectPath) !== project) {
      return res.status(400).json({ error: 'task does not belong to project' });
    }

    try {
      const started = await startQaSession({
        projectPath: project,
        taskId: task.id,
        taskTitle: task.title,
        taskDescription: task.description,
        backendOrigin,
      });
      res.json({
        id: started.id,
        taskId: started.taskId,
        command: started.command,
        cwd: started.cwd,
        serverId: started.serverId,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Polled by the frontend so it can close the terminal once Claude stops.
  r.get('/api/qa-runs/:id', (req, res) => {
    const run = getQaRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json({
      id: run.id,
      status: run.status,
      taskId: run.taskId,
      projectPath: run.projectPath,
    });
  });

  // Stop-hook callback. Idempotent: a duplicate POST after the run has been
  // forgotten just no-ops.
  r.post('/api/qa-runs/:id/done', async (req, res) => {
    const run = getQaRun(req.params.id);
    // Drop the graph node regardless of whether the run is still tracked.
    unregisterAgentSession(qaAgentId(req.params.id));
    if (!run) return res.json({ ok: true });
    markQaRunDone(run.id);
    // Cleanup the home-scoped scratch dir off the response path so a slow
    // Windows fs.rm doesn't keep the curl call open past its 5s timeout.
    void cleanupQaSession(run.projectPath, run.id);
    res.json({ ok: true });
  });

  // Allow the frontend to drop the run from the registry once it's seen the
  // 'done' status — keeps the map from growing forever in long sessions.
  r.delete('/api/qa-runs/:id', (req, res) => {
    forgetQaRun(req.params.id);
    res.json({ ok: true });
  });

  return r;
}
