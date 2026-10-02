import { useMergeRunSync } from './useMergeRunSync';
import { usePostMergeHook } from './usePostMergeHook';
import { usePushRun } from './usePushRun';
import { useHarnessSelector } from './useHarnessSelector';
import { useQaPlaywright } from './useQaPlaywright';
import { useQaRuns } from './useQaRuns';
import type { AddTerminal } from '../../../terminal/terminalTypes';

type CloseTerminal = (id: string) => void;
type CloseTerminalsForTask = (taskId: string, keep?: { id?: string; serverId?: string }) => void;
type QaRunTerminals = Parameters<typeof useQaRuns>[4];

// Run controllers for task-board adjunct workflows. This keeps long-lived run
// orchestration (merge-all, push, QA e2e, post-merge hook, and harness/model
// selection) out of the data/view and detail-action wiring.
export function useTaskBoardRunControllers(
  activeFolder: string,
  addTerminal: AddTerminal,
  closeTerminal: CloseTerminal,
  closeTerminalsForTask: CloseTerminalsForTask,
  showError: (msg: string) => void,
  qaRunTerminals?: QaRunTerminals,
) {
  const merge = useMergeRunSync(
    activeFolder,
    addTerminal,
    closeTerminalsForTask,
    showError,
  );
  const push = usePushRun(
    activeFolder,
    addTerminal,
    closeTerminal,
    showError,
  );
  const harness = useHarnessSelector(activeFolder);
  const qaPlaywright = useQaPlaywright(activeFolder, showError);
  const qaRuns = useQaRuns(
    activeFolder,
    addTerminal,
    closeTerminal,
    showError,
    qaRunTerminals,
  );
  const postMergeHook = usePostMergeHook(activeFolder, addTerminal, showError);

  return {
    ...merge,
    ...push,
    ...harness,
    qaPlaywright,
    ...qaRuns,
    postMergeHook,
  };
}
