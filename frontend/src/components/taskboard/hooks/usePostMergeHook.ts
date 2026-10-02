import type { AddTerminal } from '../../../terminal/terminalTypes';
import { usePostMergeHookForm } from './usePostMergeHookForm';
import { usePostMergeHookRun } from './usePostMergeHookRun';

export type { PostMergeHookFormState } from './usePostMergeHookForm';

// Per-project state for the PostMergeHookRow: the persisted prompt/harness
// form values plus the live active/recent hook run. The component owns
// presentation; this hook composes the two I/O lifecycles.
export function usePostMergeHook(
  activeFolder: string,
  addTerminal: AddTerminal,
  showError: (msg: string) => void,
) {
  const { form, loaded, saving, savePrompt, saveEnabled, saveHarness } =
    usePostMergeHookForm(activeFolder, showError);
  const { active, recent, abort } = usePostMergeHookRun(activeFolder, addTerminal, showError);

  return {
    form,
    loaded,
    active,
    recent,
    saving,
    savePrompt,
    saveEnabled,
    saveHarness,
    abort,
  };
}
