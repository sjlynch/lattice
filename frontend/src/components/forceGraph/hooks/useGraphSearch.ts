import { useEffect, useMemo, useRef, useState } from 'react';
import { searchProjectContents, type ScanResult } from '../../../api';
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

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Drives the graph's search bar. Filename matches are computed client-side off
// the loaded graph (instant); file-contents matches come from a debounced,
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
}): SearchStatus {
  const { data, activeFolder, query, regex, contents, setSelected } = params;
  const trimmed = query.trim();

  const matcher = useMemo(
    () => buildSearchRegExp(trimmed, regex),
    [trimmed, regex],
  );
  const invalidRegex = regex && trimmed.length > 0 && matcher === null;

  // Filename pass — pure and instant, recomputed when the data or query change
  // (so renamed/added/removed files re-match live). Empty query → empty Set
  // (matcher is null), so there's no O(N) scan when search is idle.
  const fileNameMatches = useMemo(() => {
    const ids = new Set<string>();
    if (!data || !matcher) return ids;
    for (const n of data.nodes) {
      if (n.kind !== 'file') continue;
      if (matcher.test(n.name)) ids.add(n.id);
    }
    return ids;
  }, [data, matcher]);

  const [contentMatches, setContentMatches] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  // Debounced, cancelable contents pass. Skipped entirely unless the contents
  // toggle is on. Deps intentionally exclude `data` — see the snapshot note.
  useEffect(() => {
    if (!contents || !matcher || trimmed.length < CONTENT_MIN_LEN || !activeFolder) {
      setContentMatches(new Set());
      setSearching(false);
      setError(null);
      setTruncated(false);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchProjectContents(activeFolder, {
        query: trimmed,
        regex,
        signal: controller.signal,
      })
        .then((res) => {
          if (cancelled) return;
          setContentMatches(new Set(res.matches));
          setTruncated(res.truncated);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled || controller.signal.aborted) return;
          setError(e instanceof Error ? e.message : String(e));
          setContentMatches(new Set());
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

  // Combined match set; recomputed when either pass changes.
  const union = useMemo(() => {
    if (trimmed.length === 0) return new Set<string>();
    const s = new Set<string>(fileNameMatches);
    for (const id of contentMatches) s.add(id);
    return s;
  }, [trimmed, fileNameMatches, contentMatches]);

  // Push the combined set into the shared selection. Only restore to empty on
  // clear if *we* were the last to drive the selection. Guarded against
  // redundant applies (the health watcher churns `data`, hence
  // `fileNameMatches`, with an identical match set on every file save).
  const droveRef = useRef(false);
  const lastAppliedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (trimmed.length === 0) {
      if (droveRef.current) {
        droveRef.current = false;
        lastAppliedRef.current = new Set();
        setSelected(new Set());
      }
      return;
    }
    if (droveRef.current && sameSet(union, lastAppliedRef.current)) return;
    droveRef.current = true;
    lastAppliedRef.current = union;
    setSelected(new Set(union));
  }, [trimmed, union, setSelected]);

  return {
    active: trimmed.length > 0,
    invalidRegex,
    searching,
    error,
    matchCount: union.size,
    truncated,
  };
}
