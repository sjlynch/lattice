import type { MergeRun, Task } from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';
import type { GroupedTasks } from './useTaskBoardState';
import type { ResolvedHarness } from './useHarnessSelector';
import { useTaskCrudActions } from './useTaskCrudActions';
import { useTaskLifecycleActions } from './useTaskLifecycleActions';
import { useTaskMergeActions } from './useTaskMergeActions';
import { useTaskReorderActions } from './useTaskReorderActions';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

type UseTaskActionsArgs = {
  activeFolder: string;
  tasks: Task[];
  grouped: GroupedTasks;
  mergeRun: MergeRun | null;
  addTerminal: AddTerminal;
  clearSelection: () => void;
  pickInterleaveHarness: () => ResolvedHarness;
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
  mergeRun,
  addTerminal,
  clearSelection,
  pickInterleaveHarness,
  showError,
}: UseTaskActionsArgs) {
  const crud = useTaskCrudActions({ activeFolder, showError });
  const reorder = useTaskReorderActions({
    activeFolder,
    tasks,
    grouped,
    clearSelection,
    showError,
  });
  const lifecycle = useTaskLifecycleActions({
    tasks,
    pickInterleaveHarness,
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
