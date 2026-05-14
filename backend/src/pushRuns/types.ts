export type PushRun = {
  id: string;
  projectPath: string;
  cwd: string;
  status: 'running' | 'done';
  createdAt: number;
  doneAt?: number;
};

export type PushSession = {
  id: string;
  cwd: string;
  instructionsFile: string;
};
