// QA e2e-run lifecycle: spawn a Playwright-enabled Claude session (from
// home-scoped scratch) that exercises a merged QA-lane task end-to-end, then
// closes itself when Claude stops (via a settings.local.json Stop hook). The
// QA-lane Playwright toggle must be on for the project, or the Playwright MCP
// won't be injected — the frontend only surfaces the buttons in that case.
//
// This file is just route wiring: the request guards, response shaping, and
// verdict-body parsing live in focused helpers under `./qaRuns/`, and the QA
// lifecycle (spawn / verdict / cleanup) stays in the `../qaRuns` modules.

import { Router } from 'express';
import { getTask } from '../tasks.js';
import {
  applyQaVerdict,
  applyRecordedQaVerdict,
  cleanupQaSession,
  forgetQaRun,
  getQaRun,
  markQaRunDone,
  qaAgentId,
  recordQaRunAutoClose,
  startQaSession,
} from '../qaRuns.js';
import { unregisterAgentSession } from '../agentSessions.js';
import { isQaTerminalAutoCloseEnabled } from '../userSettings.js';
import {
  deleteHomeScratchRunResponse,
  finishHomeScratchDoneResponse,
} from '../homeScratch/routes.js';
import { parseVerdictBody } from './qaRuns/verdictBody.js';
import { resolveQaRunStart } from './qaRuns/startGuard.js';
import { polledQaRunResponse, startedQaRunResponse } from './qaRuns/responses.js';

// Re-exported for the route-level regression tests, which assert the verdict
// parsing directly.
export { parseVerdictBody };

// Injectable seams for the route-level regression test, so it can exercise the
// real guards without touching the task DB or spawning a Claude session.
// Production passes nothing and gets the real `getTask` / `startQaSession`.
export type QaRunsRouterDeps = {
  getTask?: typeof getTask;
  startQaSession?: typeof startQaSession;
};

export function buildQaRunsRouter(
  backendOrigin: string,
  deps: QaRunsRouterDeps = {},
): Router {
  const r = Router();
  const lookupTask = deps.getTask ?? getTask;
  const startSession = deps.startQaSession ?? startQaSession;

  r.post('/api/qa-runs', async (req, res) => {
    const resolved = await resolveQaRunStart(req.body, lookupTask);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ error: resolved.error });
    }

    try {
      const started = await startSession({
        projectPath: resolved.project,
        taskId: resolved.task.id,
        taskTitle: resolved.task.title,
        taskDescription: resolved.task.description,
        backendOrigin,
      });
      res.json(startedQaRunResponse(started));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Polled by the frontend so it can close the terminal once Claude stops.
  r.get('/api/qa-runs/:id', (req, res) => {
    const run = getQaRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    res.json(polledQaRunResponse(run));
  });

  // Verdict callback — the agent's final step. A confident PASS promotes the
  // task qa → done; anything else leaves it in the QA lane for human review.
  // Reported before the session stops (and thus before the /done Stop hook
  // fires), so the move lands while the run is still tracked.
  r.post('/api/qa-runs/:id/verdict', async (req, res) => {
    const { passed, confident } = parseVerdictBody(req.body);
    try {
      const outcome = await applyQaVerdict(req.params.id, { passed, confident });
      res.json(outcome);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Stop-hook callback. Idempotent: a duplicate POST after the run has been
  // forgotten just no-ops.
  r.post('/api/qa-runs/:id/done', async (req, res) => {
    const id = req.params.id;
    const run = getQaRun(id);
    // Drop the graph node regardless of whether the run is still tracked.
    unregisterAgentSession(qaAgentId(id));
    await finishHomeScratchDoneResponse({
      res,
      run,
      onRun: async (tracked) => {
        // Backstop the qa → done transition off the reliable Stop hook, the way
        // in_progress → ready_to_merge fires from the Stop hook / Pi completion
        // extension rather than the model's memory. If the agent's explicit
        // /verdict curl already advanced the task this is an idempotent no-op;
        // if that move was missed (or raced this callback) the recorded
        // confident PASS is applied here. A fail / unsure / absent verdict
        // still leaves it in QA.
        await applyRecordedQaVerdict(tracked.id);
        markQaRunDone(tracked.id);
        // Resolve once whether the QA terminal should auto-close (default:
        // stay open so the user can read the verdict/output) and record it on
        // the run so the frontend poller mirrors the same decision when it next
        // sees `done`.
        const autoClose = await isQaTerminalAutoCloseEnabled(tracked.projectPath);
        recordQaRunAutoClose(tracked.id, autoClose);
        if (autoClose) {
          // Auto-close: tear down the pty + reclaim the home-scoped scratch dir
          // off the response path so a slow Windows fs.rm doesn't keep the curl
          // call open past its 5s timeout. (The original pre-toggle behavior.)
          void cleanupQaSession(tracked.projectPath, tracked.id);
        }
        // Stay-open: leave the live pty + scratch in place so the terminal stays
        // readable. The boot-time sweep (sweepOrphanedQaSessions) reclaims the
        // scratch dir on the next restart, and closing the tab kills the pty.
      },
    });
  });

  // Allow the frontend to drop the run from the registry once it's seen the
  // 'done' status — keeps the map from growing forever in long sessions.
  r.delete('/api/qa-runs/:id', (req, res) => {
    deleteHomeScratchRunResponse({
      res,
      id: req.params.id,
      forget: forgetQaRun,
    });
  });

  return r;
}
