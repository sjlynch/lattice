export type TaskStatus =
  | 'backlog'
  | 'open'
  | 'in_progress'
  | 'ready_to_merge'
  | 'qa'
  | 'done'
  | 'deleted';

import type { AgentHarness } from '../harnesses.js';

export type Task = {
  id: string;
  projectPath: string;
  title: string;
  description?: string;
  // Agent-contributed resolution / progress notes, appended via
  // POST /api/tasks/:id/append-summary as a task moves through the pipeline
  // (the worktree agent's change summary, then a QA verdict, …). Kept SEPARATE
  // from `description` on purpose: the original ticket text (the human-authored
  // ask) must never be overwritten by an agent's summary — the board shows
  // both. Multiple appends are joined with a `---` divider.
  summary?: string;
  status: TaskStatus;
  createdAt: number;
  // Timestamp of the most recent mutation (any field). Set by updateTask /
  // updateTaskCrashSafe; not set by createTask (use createdAt for that).
  updatedAt?: number;
  worktreePath?: string;
  branch?: string;
  startedAt?: number;
  completedAt?: number;
  mergedAt?: number;
  doneAt?: number;
  conflict?: boolean;
  // When the conflict was first detected. Drives the "stuck for X min"
  // indicator on conflict cards so the user can spot a hung resolver.
  conflictStartedAt?: number;
  // Manual ordering within a lane. Lower values sort first. Tasks without a
  // value fall back to `-createdAt` so newly-created tasks land on top, which
  // matches the pre-reorder behavior.
  sortOrder?: number;
  // When this task was spawned by a Workflow run, these record the run it
  // belongs to and which step in that run produced it. The workflow advancer
  // watches for tagged tasks transitioning to `qa` and creates the next step.
  workflowRunId?: string;
  workflowStepIndex?: number;
  // Set while an Open task's run is waiting in the spawn queue (the
  // terminal-server's concurrency softCap was full when it was requested).
  // Status stays `open`; the card just renders a "Queued" badge. Cleared
  // when the spawn-queue thunk admits the run and flips it to in_progress.
  // Persisted so boot recovery can re-enqueue a run interrupted by a restart.
  runQueued?: boolean;
  runQueuedAt?: number;
  // The harness that actually ran this task's worktree agent, recorded at
  // spawn time (startTask). The graph's Claude-agent overlay reads this to
  // scope itself to `claude` tasks — Codex/Pi have no PreToolUse/PostToolUse
  // activity hooks yet, so they get no live focus beams.
  harness?: AgentHarness;
  // The Pi model ("provider/model") this task's worktree agent ran with, when
  // the harness was `pi`. Recorded at spawn so a resume re-uses the same model
  // without the UI having to re-send it. Absent for non-Pi tasks.
  piModel?: string;
  // A stable palette slot assigned at spawn time (smallest index free among
  // the project's currently-active tasks). Drives the per-task accent color
  // shared by the card's left edge, the Claude node, and the `W` worktree
  // rings. Persisted so the color never reshuffles as sibling tasks finish;
  // freed for reuse once this task leaves the active lanes.
  colorIndex?: number;
};

export type TaskUpdates = Partial<
  Omit<Task, 'id' | 'projectPath' | 'createdAt'>
>;

export type TaskSubscriber = (projectPath: string, tasks: Task[]) => void;
