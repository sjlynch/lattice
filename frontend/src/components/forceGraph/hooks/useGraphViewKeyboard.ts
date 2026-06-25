import { useEffect, type MutableRefObject } from 'react';
import { useRefMirror } from './useRefMirror';

type Args = {
  // The currently-open context menu (or null) + its setter.
  contextMenu: { x: number; y: number } | null;
  setContextMenu: (v: null) => void;
  // Whether the create-task modal is open (it handles its own Escape close, so
  // the global handler only needs to know it's up to skip the other branches).
  modalOpen: boolean;
  // Active search query + its setter (Escape clears it before clearing
  // selection).
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  // Clears the search match-navigation cursor when the query is cleared.
  clearCurrentMatch: () => void;
  // Live selection (read through a ref the coordinator already owns) + setter.
  selectedRef: MutableRefObject<Set<string>>;
  setSelected: (s: Set<string>) => void;
};

// The graph view's Escape-key behavior, extracted from the coordinator. Escape
// dismisses the most specific thing first: an open context menu, then (the
// modal closes itself), then an active search query (+ its match cursor), then
// the current selection. Bound ONCE — every branch input is read through a ref
// so the listener isn't removed/re-added on each selection change or search
// keystroke (it previously re-bound per keystroke).
export function useGraphViewKeyboard({
  contextMenu,
  setContextMenu,
  modalOpen,
  searchQuery,
  setSearchQuery,
  clearCurrentMatch,
  selectedRef,
  setSelected,
}: Args): void {
  const contextMenuRef = useRefMirror(contextMenu);
  const modalOpenRef = useRefMirror(modalOpen);
  const searchQueryRef = useRefMirror(searchQuery);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (contextMenuRef.current) setContextMenu(null);
      else if (modalOpenRef.current) {
        // Modal handles its own Escape close
      } else if (searchQueryRef.current) {
        // Clearing the query also clears its driven selection (useGraphSearch)
        // and the match-navigation cursor.
        setSearchQuery('');
        clearCurrentMatch();
      } else if (selectedRef.current.size > 0) {
        setSelected(new Set());
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
