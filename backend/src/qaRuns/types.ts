export type QaRun = {
  id: string;
  // The QA-lane task this e2e run is exercising.
  taskId: string;
  projectPath: string;
  cwd: string;
  status: 'running' | 'done';
  createdAt: number;
  doneAt?: number;
};

export type QaSession = {
  id: string;
  cwd: string;
  instructionsFile: string;
};
