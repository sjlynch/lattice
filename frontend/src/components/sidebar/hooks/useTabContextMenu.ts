import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';
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

  useEffect(() => {
    if (!tabContextMenu) return;
    function onPointerDown(e: PointerEvent) {
      if (tabContextMenuRef.current && !tabContextMenuRef.current.contains(e.target as Node)) {
        setTabContextMenu(null);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setTabContextMenu(null);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [tabContextMenu]);

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
      if (toClose.length > 0) closeTerminals(toClose);
      setTabContextMenu(null);
    },
    [visibleTerminals, closeTerminals],
  );

  const handleCloseTabsToRight = useCallback(
    (termId: string) => {
      const idx = visibleTerminals.findIndex((t) => t.id === termId);
      const toClose = visibleTerminals.slice(idx + 1).map((t) => t.id);
      if (toClose.length > 0) closeTerminals(toClose);
      setTabContextMenu(null);
    },
    [visibleTerminals, closeTerminals],
  );

  const handleCloseOtherTabs = useCallback(
    (termId: string) => {
      const toClose = visibleTerminals.filter((t) => t.id !== termId).map((t) => t.id);
      if (toClose.length > 0) closeTerminals(toClose);
      setTabContextMenu(null);
    },
    [visibleTerminals, closeTerminals],
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
