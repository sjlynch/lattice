// Response shaping for the QA-run routes: pick exactly the fields the frontend
// consumes off the richer internal records, so the route handlers stay wiring.
// The JSON shapes here are load-bearing — the frontend poller reads them — so
// they must not drift.

import type { StartedQaSession } from '../../qaRuns.js';
import type { QaRun } from '../../qaRuns.js';

// The started-run payload the POST /api/qa-runs caller gets back (enough to
// mount the pre-spawned terminal and track the run).
export function startedQaRunResponse(started: StartedQaSession): {
  id: string;
  taskId: string;
  command: string;
  cwd: string;
  serverId?: string;
  terminalId?: string;
} {
  return {
    id: started.id,
    taskId: started.taskId,
    command: started.command,
    cwd: started.cwd,
    serverId: started.serverId,
    terminalId: started.terminalId,
  };
}

// The polled snapshot from GET /api/qa-runs/:id. `autoCloseTerminal` is
// resolved at `/done` time; the frontend poller closes the tab only when it is
// true (default is stay-open).
export function polledQaRunResponse(run: QaRun): {
  id: string;
  status: QaRun['status'];
  taskId: string;
  projectPath: string;
  verdict: QaRun['verdict'];
  movedToDone: QaRun['movedToDone'];
  autoCloseTerminal: QaRun['autoCloseTerminal'];
} {
  return {
    id: run.id,
    status: run.status,
    taskId: run.taskId,
    projectPath: run.projectPath,
    verdict: run.verdict,
    movedToDone: run.movedToDone,
    autoCloseTerminal: run.autoCloseTerminal,
  };
}
