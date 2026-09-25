import { useEffect, useMemo, useRef, useState } from 'react';
import { searchProjectContents, type ScanResult } from '../../../api';
import { useStructuralScan } from '../../../hooks/useStructuralScan';
import { buildSearchRegExp } from '../searchMatcher';

// Debounce before hitting the backend contents pass — filename matches update
// instantly; only the (relatively expensive) file-read pass waits for a pause.
const CONTENT_DEBOUNCE_MS = 300;
// Don't grep every file in the tree for a single character.
const CONTENT_MIN_LEN = 2;

export type SearchStatus = {
  // Query is non-empty (search is driving the selection).
  active: boolean;
  // Regex mode is on but the pattern doesn't compile.
  invalidRegex: boolean;
  // Backend contents pass is in flight.
  searching: boolean;
  // Backend error message (non-abort), if any.
  error: string | null;
  // Total selected = filename ∪ contents matches.
  matchCount: number;
  // Backend hit its match cap.
  truncated: boolean;
};

export type SearchResult = {
  status: SearchStatus;
  // Ordered match ids (== file/folder node ids) for prev/next navigation. Sorted so
  // stepping follows a stable, predictable order across re-renders; a fresh
  // array reference whenever the match set changes (so consumers can reset
  // their "current match" cursor off its identity).
  matches: string[];
};

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// The inputs a contents pass was run for. A result is only allowed to
// contribute to the union while these still match the current search — see the
// stale-scope note on the contents effect below.
type ContentScope = { project: string; query: string; regex: boolean };
type ContentResult = { scope: ContentScope; matches: Set<string>; truncated: boolean };

function scopeIsCurrent(
  scope: ContentScope,
  project: string,
  query: string,
  regex: boolean,
): boolean {
  return scope.project === project && scope.query === query && scope.regex === regex;
}

// Drives the graph's search bar. File- and folder-name matches are computed
// client-side off the loaded graph (instant); file-contents matches come from a debounced,
// cancelable backend call. Both feed the shared `selected` set so they reuse
// the existing selection ring (halo.ts) — one source of truth for the ring.
//
// Selection ownership: while a query is active the search owns `selected`.
// Clearing a search we drove restores it to empty; an empty box never wipes a
// selection the user made by hand (box-select / click).
//
// The contents pass is opt-in (`contents`) — name-only search is the zero-cost
// default. It's a snapshot taken when the query/regex/folder/toggle change — it
// deliberately does NOT re-run when file *contents* change under it (the health
// watcher pushes a fresh `data` ref on every save; re-greping the whole tree on
// each of those would hammer the backend). Re-type or toggle to refresh.
export function useGraphSearch(params: {
  data: ScanResult | null;
  activeFolder: string;
  query: string;
  regex: boolean;
  contents: boolean;
  setSelected: (next: Set<string>) => void;
  // Bumped by useGraphDataSync on every full graphData() swap — which also
  // resets the shared selection. An active search must re-apply after it.
  dataGeneration?: number;
}): SearchResult {
  const { data, activeFolder, query, regex, contents, setSelected, dataGeneration = 0 } = params;
  const trimmed = query.trim();

  const matcher = useMemo(
    () => buildSearchRegExp(trimmed, regex),
    [trimmed, regex],
  );
  const invalidRegex = regex && trimmed.length > 0 && matcher === null;

  // Filename pass — pure and instant, recomputed when the structure or query
  // change (so renamed/added/removed files re-match live). Folder nodes are
  // matched by name too, so a folder hit gets the same selection ring as a file
  // hit (the contents pass is file-only by nature). Keyed off the
  // structure-stable scan reference (names/ids only — structural), so a
  // metric-only file save no longer re-runs the O(N) scan while a query is
  // active. Empty query → empty Set (matcher is null), so there's no scan when
  // search is idle.
  const structuralData = useStructuralScan(data);
  const fileNameMatches = useMemo(() => {
    const ids = new Set<string>();
    if (!structuralData || !matcher) return ids;
    for (const n of structuralData.nodes) {
      if (n.kind !== 'file' && n.kind !== 'dir') continue;
      if (matcher.test(n.name)) ids.add(n.id);
    }
    return ids;
  }, [structuralData, matcher]);

  // The contents result carries the scope it was produced for. It's a single
  // shared piece of state across every project/query, so on a folder or query
  // change the previous scope's absolute file ids linger in it until the new
  // pass resolves — including them blindly would briefly union (and select) old
  // project ids. The scope tag lets every consumer synchronously ignore a stale
  // result on the very render the inputs change (before this effect re-runs).
  const [contentResult, setContentResult] = useState<ContentResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced, cancelable contents pass. Skipped entirely unless the contents
  // toggle is on. Deps intentionally exclude `data` — see the snapshot note.
  useEffect(() => {
    if (!contents || !matcher || trimmed.length < CONTENT_MIN_LEN || !activeFolder) {
      setContentResult(null);
      setSearching(false);
      setError(null);
      return;
    }
    // Capture the scope this run searches so the async result can be tagged with
    // it (and rejected by consumers if the inputs have since moved on).
    const scope: ContentScope = { project: activeFolder, query: trimmed, regex };
    const controller = new AbortController();
    let cancelled = false;
    setSearching(true);
    // Drop a prior scope's error the moment a new search starts, so a stale
    // failure can't cling to the fresh scope.
    setError(null);
    const timer = setTimeout(() => {
      searchProjectContents(activeFolder, {
        query: trimmed,
        regex,
        signal: controller.signal,
      })
        .then((res) => {
          if (cancelled) return;
          setContentResult({ scope, matches: new Set(res.matches), truncated: res.truncated });
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          setContentResult(null);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, CONTENT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, regex, contents, matcher, activeFolder]);

  // Combined match set; recomputed when either pass changes. A contents result
  // only counts while it was produced for the *current* `{ activeFolder,
  // trimmed, regex }` scope — a stale one (folder/query/mode just changed, its
  // replacement not yet resolved) is ignored, so old-project ids never enter
  // the union (and hence never reach `setSelected`).
  const union = useMemo(() => {
    if (trimmed.length === 0) return new Set<string>();
    const s = new Set<string>(fileNameMatches);
    if (contentResult && scopeIsCurrent(contentResult.scope, activeFolder, trimmed, regex)) {
      for (const id of contentResult.matches) s.add(id);
    }
    return s;
  }, [trimmed, regex, activeFolder, fileNameMatches, contentResult]);

  // Push the combined set into the shared selection. Only restore to empty on
  // clear if *we* were the last to drive the selection. Guarded against
  // redundant applies (the health watcher churns `data`, hence
  // `fileNameMatches`, with an identical match set on every file save).
  // A structural rescan (`dataGeneration` bump) wipes the selection out from
  // under the search, so the "already applied" guard is keyed on the generation
  // too: the same match set is re-applied once after every swap.
  const droveRef = useRef(false);
  const lastAppliedRef = useRef<Set<string>>(new Set());
  const lastAppliedGenRef = useRef(dataGeneration);
  useEffect(() => {
    if (trimmed.length === 0) {
      if (droveRef.current) {
        droveRef.current = false;
        lastAppliedRef.current = new Set();
        setSelected(new Set());
      }
      return;
    }
    if (
      droveRef.current &&
      lastAppliedGenRef.current === dataGeneration &&
      sameSet(union, lastAppliedRef.current)
    ) return;
    droveRef.current = true;
    lastAppliedRef.current = union;
    lastAppliedGenRef.current = dataGeneration;
    setSelected(new Set(union));
  }, [trimmed, union, setSelected, dataGeneration]);

  // Ordered match list for prev/next navigation — a stable sort over the union
  // so stepping is predictable, and a fresh reference only when the set changes.
  const matches = useMemo(() => Array.from(union).sort(), [union]);

  // Return a stable status object keyed on its scalar fields so consumers that
  // memoize on the status (the HUD / search bar) aren't re-rendered by a
  // fresh-but-equal object every render. `matches` is threaded separately so it
  // never churns that memo.
  const active = trimmed.length > 0;
  const matchCount = union.size;
  // Only an in-scope result can be truncated; a stale scope's cap flag must not
  // bleed into the new folder/query.
  const truncated =
    contentResult !== null &&
    scopeIsCurrent(contentResult.scope, activeFolder, trimmed, regex) &&
    contentResult.truncated;
  const status = useMemo(
    () => ({ active, invalidRegex, searching, error, matchCount, truncated }),
    [active, invalidRegex, searching, error, matchCount, truncated],
  );
  return useMemo(() => ({ status, matches }), [status, matches]);
}
