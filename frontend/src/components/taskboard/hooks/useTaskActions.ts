import type { MergeRun, Task, TaskStatus } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import type { LaneSortMode } from '../laneSort';
import type { GroupedTasks } from './useTaskBoardState';
import type { RunHarnessSelection } from './useHarnessSelector';
import { useTaskCrudActions } from './useTaskCrudActions';
import { useTaskLifecycleActions } from './useTaskLifecycleActions';
import { useTaskMergeActions } from './useTaskMergeActions';
import { useTaskReorderActions } from './useTaskReorderActions';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

type UseTaskActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  grouped: GroupedTasks;
  getLaneSortMode: (status: TaskStatus) => LaneSortMode;
  mergeRun: MergeRun | null;
  addTerminal: AddTerminal;
  clearSelection: () => void;
  pickRunHarness: () => RunHarnessSelection;
  showError: (message: string) => void;
};

// Composes per-concern action hooks (CRUD, reorder, lifecycle, merge)
// into the single stable shape consumed by TaskBoardLauncher. Each
// sub-hook lives in its own file; this one just wires them together
// and surfaces every callback at the top level.
export function useTaskActions({
  activeFolder,
  tasks,
  grouped,
  getLaneSortMode,
  mergeRun,
  addTerminal,
  clearSelection,
  pickRunHarness,
  showError,
}: UseTaskActionsArgs) {
  const crud = useTaskCrudActions({ activeFolder, showError });
  const reorder = useTaskReorderActions({
    activeFolder,
    tasks,
    grouped,
    getLaneSortMode,
    clearSelection,
    showError,
  });
  const lifecycle = useTaskLifecycleActions({
    tasks,
    pickRunHarness,
    showError,
  });
  const merge = useTaskMergeActions({
    activeFolder,
    tasks,
    mergeRun,
    addTerminal,
    moveTask: crud.moveTask,
    showError,
  });

  return {
    ...crud,
    ...reorder,
    ...lifecycle,
    ...merge,
  };
}
