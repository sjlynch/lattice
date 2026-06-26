import { useCallback, useState, type MutableRefObject } from 'react';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { ScanResult } from '../../../api';
import { useGraphSearch } from './useGraphSearch';
import { useGraphSearchNavigation } from './useGraphSearchNavigation';

type Args = {
  data: ScanResult | null;
  activeFolder: string;
  graphRef: MutableRefObject<ForceGraph3DInstance | null>;
  setSelected: (next: Set<string>) => void;
};

// Owns the file-search state (query + regex/contents toggles) and wires the two
// search hooks together: `useGraphSearch` (filename + opt-in contents passes,
// both feeding the shared `selected` set) and `useGraphSearchNavigation` (the
// prev/next match cursor + camera focus). Returns the HUD-ready
// status/position/handlers plus the `searchQuery`/`setSearchQuery`/
// `clearCurrentMatch` the Escape chord (`useGraphViewKeyboard`) needs.
//
// The toggle/query handlers use the functional-updater form so they stay
// referentially stable (empty deps) — keeping the memoized HUD / search bar off
// the per-keystroke render path.
export function useGraphSearchController({
  data,
  activeFolder,
  graphRef,
  setSelected,
}: Args) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchRegex, setSearchRegex] = useState(false);
  // File-contents search is opt-in — name-only is the zero-cost default.
  const [searchContents, setSearchContents] = useState(false);

  // Search bar: filename matches (instant, client-side) + file-contents matches
  // (debounced backend pass) both feed the shared `selected` set, so a match
  // shows the standard selection ring. `searchMatches` is the ordered id list
  // backing prev/next match navigation.
  const { status: searchStatus, matches: searchMatches } = useGraphSearch({
    data,
    activeFolder,
    query: searchQuery,
    regex: searchRegex,
    contents: searchContents,
    setSelected,
  });

  // Prev/next match navigation + camera focus: cursor state (tracked by match
  // *id*), the prev/next handlers, and the camera tween / idle-wake pulse all
  // live in their own hook. A fresh query / Escape clears the cursor via the
  // returned `clearCurrentMatch`.
  const { searchMatchPosition, goPrevMatch, goNextMatch, clearCurrentMatch } =
    useGraphSearchNavigation({ graphRef, searchMatches });

  const toggleSearchRegex = useCallback(() => setSearchRegex((v) => !v), []);
  const toggleSearchContents = useCallback(
    () => setSearchContents((v) => !v),
    [],
  );
  // Any query change is a fresh search, so drop the current-match cursor (the
  // "X of Y" only reappears once the user steps again).
  const handleSearchQueryChange = useCallback(
    (q: string) => {
      setSearchQuery(q);
      clearCurrentMatch();
    },
    [clearCurrentMatch],
  );

  return {
    searchQuery,
    setSearchQuery,
    searchRegex,
    searchContents,
    toggleSearchRegex,
    toggleSearchContents,
    handleSearchQueryChange,
    searchStatus,
    searchMatchPosition,
    goPrevMatch,
    goNextMatch,
    clearCurrentMatch,
  };
}
