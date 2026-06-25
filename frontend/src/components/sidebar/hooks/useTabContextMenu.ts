import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';
import { useDismissOnOutside } from '../../../hooks/useDismissOnOutside';
import { useConfirm } from '../../shared/ConfirmDialog';
import type { Panel } from './usePanelState';

type TabContextMenuState = {
  x: number;
  y: number;
  termId: string;
};

type UseTabContextMenuArgs = {
  activePanel: Panel;
  visibleTerminals: TerminalSpec[];
  closeTerminals: (ids: string[]) => void;
};

export function useTabContextMenu({
  activePanel,
  visibleTerminals,
  closeTerminals,
}: UseTabContextMenuArgs) {
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenuState | null>(null);
  const tabContextMenuRef = useRef<HTMLDivElement>(null);
  const { confirm } = useConfirm();

  // Bulk-close is irreversible (the ptys are killed), so confirm with the
  // count first. Closing the popover before the dialog keeps it from lingering
  // behind the backdrop.
  const confirmBulkClose = useCallback(
    async (toClose: string[], where: string): Promise<void> => {
      setTabContextMenu(null);
      if (toClose.length === 0) return;
      const noun = toClose.length === 1 ? 'terminal' : 'terminals';
      const ok = await confirm({
        title: 'Close terminals',
        message: `Close ${toClose.length} ${noun} ${where}?`,
        confirmLabel: 'Close',
      });
      if (ok) closeTerminals(toClose);
    },
    [confirm, closeTerminals],
  );

  useDismissOnOutside(tabContextMenu !== null, tabContextMenuRef, () =>
    setTabContextMenu(null),
  );

  useEffect(() => {
    setTabContextMenu(null);
  }, [activePanel]);

  const handleTabContextMenu = useCallback((e: MouseEvent, termId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setTabContextMenu({ x: e.clientX, y: e.clientY, termId });
  }, []);

  const handleCloseTabsToLeft = useCallback(
    (termId: string) => {
      const idx = visibleTerminals.findIndex((t) => t.id === termId);
      const toClose = visibleTerminals.slice(0, idx).map((t) => t.id);
      void confirmBulkClose(toClose, 'to the left');
    },
    [visibleTerminals, confirmBulkClose],
  );

  const handleCloseTabsToRight = useCallback(
    (termId: string) => {
      const idx = visibleTerminals.findIndex((t) => t.id === termId);
      const toClose = visibleTerminals.slice(idx + 1).map((t) => t.id);
      void confirmBulkClose(toClose, 'to the right');
    },
    [visibleTerminals, confirmBulkClose],
  );

  const handleCloseOtherTabs = useCallback(
    (termId: string) => {
      const toClose = visibleTerminals.filter((t) => t.id !== termId).map((t) => t.id);
      void confirmBulkClose(toClose, 'other than this one');
    },
    [visibleTerminals, confirmBulkClose],
  );

  return {
    tabContextMenu,
    tabContextMenuRef,
    handleTabContextMenu,
    handleCloseTabsToLeft,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
  };
}
