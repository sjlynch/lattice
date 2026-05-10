import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

export type Panel = 'terminals' | 'merging' | 'startup';

type UsePanelStateArgs = {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  projectTerminals: TerminalSpec[];
  regularTerminals: TerminalSpec[];
  mergeTerminals: TerminalSpec[];
  startupTerminalsList: TerminalSpec[];
  setFilter: (value: string) => void;
  setSearchOpen: (value: boolean) => void;
};

export function usePanelState({
  activeId,
  setActiveId,
  projectTerminals,
  regularTerminals,
  mergeTerminals,
  startupTerminalsList,
  setFilter,
  setSearchOpen,
}: UsePanelStateArgs) {
  const [activePanel, setActivePanel] = useState<Panel>('terminals');

  // Auto-switch to Merging panel when a new merge terminal is added.
  const prevMergeCountRef = useRef(mergeTerminals.length);
  useEffect(() => {
    if (mergeTerminals.length > prevMergeCountRef.current) {
      setActivePanel('merging');
      const newest = mergeTerminals[mergeTerminals.length - 1];
      if (newest) setActiveId(newest.id);
    }
    prevMergeCountRef.current = mergeTerminals.length;
  }, [mergeTerminals, setActiveId]);

  // When the Merging/Startup panel disappears, fall back.
  useEffect(() => {
    if (mergeTerminals.length === 0 && activePanel === 'merging') {
      setActivePanel('terminals');
    }
    if (startupTerminalsList.length === 0 && activePanel === 'startup') {
      setActivePanel('terminals');
    }
  }, [mergeTerminals.length, startupTerminalsList.length, activePanel]);

  // If activeId points to a terminal that belongs to the panel we're
  // not currently viewing (e.g. user clicked the focus-terminal button on
  // a conflict task while on the regular Terminals panel), switch panels
  // so its tab is visible.
  useEffect(() => {
    if (!activeId) return;
    const t = projectTerminals.find((p) => p.id === activeId);
    if (!t) return;
    const target: Panel =
      t.kind === 'merge' ? 'merging' : t.kind === 'startup' ? 'startup' : 'terminals';
    if (target !== activePanel) setActivePanel(target);
  }, [activeId, projectTerminals, activePanel]);

  const panelTerminals =
    activePanel === 'merging'
      ? mergeTerminals
      : activePanel === 'startup'
        ? startupTerminalsList
        : regularTerminals;

  const switchPanel = useCallback(
    (panel: Panel) => {
      setActivePanel(panel);
      setFilter('');
      setSearchOpen(false);
      const list =
        panel === 'merging'
          ? mergeTerminals
          : panel === 'startup'
            ? startupTerminalsList
            : regularTerminals;
      if (list.length === 0) {
        // Empty target panel — must clear activeId, otherwise it still
        // points at a terminal in some other panel and the
        // auto-match-panel-to-active-terminal effect above immediately
        // yanks us back. That made it impossible to switch to the
        // Terminals tab when only a startup terminal existed.
        setActiveId(null);
      } else if (!list.find((t) => t.id === activeId)) {
        setActiveId(list[list.length - 1].id);
      }
    },
    [mergeTerminals, regularTerminals, startupTerminalsList, activeId, setActiveId, setFilter, setSearchOpen],
  );

  return { activePanel, panelTerminals, switchPanel };
}
