import type { Task } from '../../tasks.js';

export type MergeReadyTask = Task & { branch: string; worktreePath: string };
