// The agent's structured end-to-end verdict, reported via
// `POST /api/qa-runs/:id/verdict` as its final step. A confident pass is what
// promotes the task qa → done; anything else leaves it in the QA lane.
export type QaVerdict = {
  // Did the feature work end-to-end?
  passed: boolean;
  // Is the agent confident enough in that verdict to auto-advance the task?
  confident: boolean;
  receivedAt: number;
};

export type QaRun = {
  id: string;
  // The QA-lane task this e2e run is exercising.
  taskId: string;
  projectPath: string;
  cwd: string;
  status: 'running' | 'done';
  createdAt: number;
  doneAt?: number;
  // The agent's reported verdict (if it called /verdict before stopping).
  verdict?: QaVerdict;
  // Set once a confident pass promoted the task to the Done lane.
  movedToDone?: boolean;
};

export type QaSession = {
  id: string;
  cwd: string;
  instructionsFile: string;
};
