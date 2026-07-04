import type { ReactNode } from 'react';
import { createElement } from 'react';
import { CheckCheck, GitMerge, Play } from 'lucide-react';
import type { Task, TaskStatus } from '../../api';

export type LaneRunAllConfig = {
  cls: string;
  disabled: boolean;
  title: string;
  aria: string;
  disabledReason: string;
  icon: ReactNode;
};

// Lane-specific bulk-action presentation. Centralized here so LaneHeader's
// JSX stays focused on layout rather than per-lane copy/icon/disabled rules.
// Returns null for lanes without a run-all action (e.g. `done`).
export function laneRunAllConfig(
  id: TaskStatus,
  tasks: Task[],
): LaneRunAllConfig | null {
  switch (id) {
    case 'ready_to_merge':
      return {
        cls: 'merge',
        disabled: tasks.length === 0,
        title: 'Merge every Ready-to-Merge task (stops on first conflict)',
        aria: 'Merge all ready tasks',
        disabledReason: 'No tasks in this lane',
        icon: createElement(GitMerge, { size: 11 }),
      };
    case 'in_progress':
      return {
        cls: 'resume',
        disabled: tasks.filter((t) => !!t.worktreePath).length === 0,
        title: 'Resume every In Progress task with an existing worktree',
        aria: 'Resume all in-progress tasks',
        disabledReason: 'No In-Progress task has a worktree to resume',
        icon: createElement(Play, { size: 11, fill: 'currentColor' }),
      };
    case 'qa':
      return {
        cls: 'qa-done',
        disabled: tasks.length === 0,
        title: 'Mark every QA task as Done',
        aria: 'Mark all QA tasks done',
        disabledReason: 'No tasks in this lane',
        icon: createElement(CheckCheck, { size: 12 }),
      };
    case 'open':
      return {
        cls: '',
        disabled: tasks.length === 0,
        title: 'Run every task in Open in a new worktree',
        aria: 'Run all open tasks',
        disabledReason: 'No tasks in this lane',
        icon: createElement(Play, { size: 11, fill: 'currentColor' }),
      };
    default:
      return null;
  }
}
