import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';
import { useDismissOnOutside } from '../../../hooks/useDismissOnOutside';
import { useConfirm } from '../../shared/ConfirmDialog';
import type { Panel } from './usePanelState';
import { bulkCloseTargets, type BulkCloseSide } from './tabBulkClose';

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

  // Targets are resolved against the tab's CURRENT position; a tab that has
  // left the visible list since the menu opened closes nothing (see
  // bulkCloseTargets).
  const closeSide = useCallback(
    (termId: string, side: BulkCloseSide, where: string) => {
      const toClose = bulkCloseTargets(
        visibleTerminals.map((t) => t.id),
        termId,
        side,
      );
      if (toClose === null) {
        setTabContextMenu(null);
        return;
      }
      void confirmBulkClose(toClose, where);
    },
    [visibleTerminals, confirmBulkClose],
  );

  const handleCloseTabsToLeft = useCallback(
    (termId: string) => closeSide(termId, 'left', 'to the left'),
    [closeSide],
  );

  const handleCloseTabsToRight = useCallback(
    (termId: string) => closeSide(termId, 'right', 'to the right'),
    [closeSide],
  );

  const handleCloseOtherTabs = useCallback(
    (termId: string) => closeSide(termId, 'others', 'other than this one'),
    [closeSide],
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
