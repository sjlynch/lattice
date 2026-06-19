import type { ReactNode } from 'react';
import { createElement } from 'react';
import {
  AlertTriangle,
  Ban,
  GitMerge,
  Play,
  TerminalSquare,
  Trash2,
} from 'lucide-react';

export type TaskCardAction = {
  key: string;
  className: string;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  icon: ReactNode;
};

// The optional per-action handlers a card may wire up. A handler being
// present is what conditions an action into the rendered row — `onDelete`
// is always supplied, so delete always renders. (Editing a task is no
// longer a button: a plain click anywhere on the card opens the editor.)
export type TaskCardActionHandlers = {
  onDelete: () => void;
  onRun?: () => void;
  onCancelQueuedRun?: () => void;
  onResume?: () => void;
  onMerge?: () => void;
  // QA lane only, and only when the Playwright MCP is on for the project:
  // launch a full end-to-end test of this merged task.
  onQaRun?: () => void;
  onFocusTerminal?: () => void;
};

type TaskCardActionContext = {
  isConflict: boolean;
};

// Declarative spec for one possible action: which handler gates it, and how
// to build the rendered action once that handler is present. Ordering of
// this list is the on-screen button order (terminal, run, cancel-queued,
// resume, merge, then the always-present delete).
type TaskCardActionSpec = {
  handler: keyof TaskCardActionHandlers;
  build: (
    onClick: () => void,
    ctx: TaskCardActionContext,
  ) => TaskCardAction;
};

const TASK_CARD_ACTION_SPECS: readonly TaskCardActionSpec[] = [
  {
    handler: 'onFocusTerminal',
    build: (onClick) => ({
      key: 'terminal',
      className: 'task-card-iconbtn terminal',
      onClick,
      title: "Focus this task's terminal",
      ariaLabel: 'Focus task terminal',
      icon: createElement(TerminalSquare, { size: 12 }),
    }),
  },
  {
    handler: 'onRun',
    build: (onClick) => ({
      key: 'run',
      className: 'task-card-iconbtn play',
      onClick,
      title: 'Run in a new worktree with Claude',
      ariaLabel: 'Run task',
      icon: createElement(Play, { size: 11, fill: 'currentColor' }),
    }),
  },
  {
    handler: 'onCancelQueuedRun',
    build: (onClick) => ({
      key: 'cancel-queued',
      className: 'task-card-iconbtn cancel-queued',
      onClick,
      title: 'Cancel queued run — drop back to Open',
      ariaLabel: 'Cancel queued run',
      icon: createElement(Ban, { size: 12 }),
    }),
  },
  {
    handler: 'onResume',
    build: (onClick) => ({
      key: 'resume',
      className: 'task-card-iconbtn resume',
      onClick,
      title: 'Resume Claude in the existing worktree',
      ariaLabel: 'Resume task',
      icon: createElement(Play, { size: 11, fill: 'currentColor' }),
    }),
  },
  {
    handler: 'onMerge',
    build: (onClick, { isConflict }) => ({
      key: 'merge',
      className: `task-card-iconbtn merge ${isConflict ? 'alert' : ''}`,
      onClick,
      title: isConflict
        ? 'Re-open conflict resolver Claude'
        : 'Merge worktree branch into this repo',
      ariaLabel: 'Merge task',
      icon: isConflict
        ? createElement(AlertTriangle, { size: 12 })
        : createElement(GitMerge, { size: 12 }),
    }),
  },
  {
    handler: 'onQaRun',
    build: (onClick) => ({
      key: 'qa-run',
      className: 'task-card-iconbtn qa-run',
      onClick,
      title: 'Run an end-to-end test with Playwright',
      ariaLabel: 'Run end-to-end test',
      icon: createElement(Play, { size: 11, fill: 'currentColor' }),
    }),
  },
  {
    handler: 'onDelete',
    build: (onClick) => ({
      key: 'delete',
      className: 'task-card-iconbtn danger',
      onClick,
      title: 'Delete',
      ariaLabel: 'Delete task',
      icon: createElement(Trash2, { size: 12 }),
    }),
  },
];

// Build the ordered action list for a card by walking the declarative specs
// and keeping only those whose gating handler was supplied. Replaces the old
// verbose if/push chain with a single data-driven pass.
export function buildTaskCardActions(
  handlers: TaskCardActionHandlers,
  ctx: TaskCardActionContext,
): TaskCardAction[] {
  const actions: TaskCardAction[] = [];
  for (const spec of TASK_CARD_ACTION_SPECS) {
    const handler = handlers[spec.handler];
    if (handler) actions.push(spec.build(handler, ctx));
  }
  return actions;
}
