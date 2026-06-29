import { useCallback, useRef } from 'react';
import { useConfirm } from '../shared/ConfirmDialog';
import { type Tab } from './settingsTabs';

type SettingsCloseFlowParams = {
  saving: boolean;
  computeDirty: () => Record<Tab, boolean>;
  save: () => Promise<void>;
  onClose: () => void;
};

// Every close path (Cancel, Escape, backdrop) routes through this hook. With
// pending edits across any tab, ask Save / Discard / Cancel first instead of
// silently dropping them. (MCP secrets aren't in the dirty check — they
// auto-save.)
export function useSettingsCloseFlow({
  saving,
  computeDirty,
  save,
  onClose,
}: SettingsCloseFlowParams) {
  const { confirmUnsaved } = useConfirm();
  const closingRef = useRef(false);

  return useCallback(async () => {
    if (saving || closingRef.current) return;
    if (!Object.values(computeDirty()).some(Boolean)) {
      onClose();
      return;
    }

    closingRef.current = true;
    try {
      const choice = await confirmUnsaved({
        message: 'You have unsaved settings changes.',
      });
      if (choice === 'cancel') return;
      if (choice === 'discard') {
        onClose();
        return;
      }
      // save() closes on success (onClose) and surfaces an error + stays open
      // on failure.
      await save();
    } finally {
      closingRef.current = false;
    }
  }, [computeDirty, confirmUnsaved, onClose, save, saving]);
}
