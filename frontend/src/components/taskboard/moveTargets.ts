import type { TaskStatus } from '../../api';

export type MoveTarget = {
  status: TaskStatus;
  label: string;
  shouldShow: (status: TaskStatus) => boolean;
};

const MOVE_TARGETS: MoveTarget[] = [
  {
    status: 'backlog',
    label: 'Move to Backlog',
    shouldShow: (status) =>
      status !== 'backlog' &&
      status !== 'in_progress' &&
      status !== 'ready_to_merge',
  },
  {
    status: 'open',
    label: 'Move to Open',
    shouldShow: (status) => status !== 'open',
  },
  {
    status: 'qa',
    label: 'Mark QA',
    shouldShow: (status) => status !== 'qa',
  },
  {
    status: 'done',
    label: 'Mark Done',
    shouldShow: (status) => status !== 'done',
  },
];

// The move buttons applicable to a task in the given status, in display order.
export function getApplicableMoveTargets(status: TaskStatus): MoveTarget[] {
  return MOVE_TARGETS.filter((target) => target.shouldShow(status));
}
