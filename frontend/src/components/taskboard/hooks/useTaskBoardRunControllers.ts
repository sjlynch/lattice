import { useMergeRunSync } from './useMergeRunSync';
import { usePostMergeHook } from './usePostMergeHook';
import { usePushRun } from './usePushRun';
import { useHarnessSelector } from './useHarnessSelector';
import { useQaPlaywright } from './useQaPlaywright';
import { useQaRuns } from './useQaRuns';
import type { TerminalSpec } from '../../../TerminalsContext';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;
type CloseTerminal = (id: string) => void;

// Run controllers for task-board adjunct workflows. This keeps long-lived run
// orchestration (merge-all, push, QA e2e, post-merge hook, and harness/model
// selection) out of the data/view and detail-action wiring.
export function useTaskBoardRunControllers(
  activeFolder: string,
  addTerminal: AddTerminal,
  closeTerminal: CloseTerminal,
  showError: (msg: string) => void,
) {
  const merge = useMergeRunSync(activeFolder, addTerminal, showError);
  const push = usePushRun(
    activeFolder,
    addTerminal,
    closeTerminal,
    showError,
  );
  const harness = useHarnessSelector(activeFolder);
  const qaPlaywright = useQaPlaywright(activeFolder);
  const qaRuns = useQaRuns(activeFolder, addTerminal, closeTerminal, showError);
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
