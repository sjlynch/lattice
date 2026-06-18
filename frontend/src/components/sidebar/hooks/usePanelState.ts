import { useCallback, useEffect, useState } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

export type Panel = 'terminals' | 'merging' | 'startup';

type UsePanelStateArgs = {
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  projectTerminals: TerminalSpec[];
  regularTerminals: TerminalSpec[];
  mergeTerminals: TerminalSpec[];
  startupTerminalsList: TerminalSpec[];
};

export function usePanelState({
  activeId,
  setActiveId,
  projectTerminals,
  regularTerminals,
  mergeTerminals,
  startupTerminalsList,
}: UsePanelStateArgs) {
  const [activePanel, setActivePanel] = useState<Panel>('terminals');

  // NOTE: deliberately do NOT auto-switch to the Merging panel or steal the
  // active terminal when a merge (conflict-resolver) terminal spawns. Both
  // spawn sites pass `focus: false` on purpose — a "Merge All" run can spawn
  // many resolvers, and yanking focus to each one (a) interrupts whatever the
  // user is doing and (b) forces each merge pane to mount, allocating an
  // xterm WebGL context per pane. A burst of those blew past Chrome's
  // per-page WebGL context cap and dropped the force-graph's context (graph
  // turned white). Merge terminals stay discoverable via the "Merging" panel
  // tab + count badge; the resolver runs server-side regardless of whether
  // its pane is ever mounted. The user can click into the Merging panel when
  // they want to watch a resolver.

  // When the Merging/Startup panel disappears, fall back to regular terminals.
  useEffect(() => {
    const panelDisappeared =
      (mergeTerminals.length === 0 && activePanel === 'merging') ||
      (startupTerminalsList.length === 0 && activePanel === 'startup');
    if (!panelDisappeared) return;

    setActivePanel('terminals');
    if (!activeId && regularTerminals.length > 0) {
      setActiveId(regularTerminals[regularTerminals.length - 1].id);
    }
  }, [
    activeId,
    activePanel,
    mergeTerminals.length,
    regularTerminals,
    setActiveId,
    startupTerminalsList.length,
  ]);

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
    [mergeTerminals, regularTerminals, startupTerminalsList, activeId, setActiveId],
  );

  return { activePanel, panelTerminals, switchPanel };
}
