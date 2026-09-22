import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPiModels, type PiModelInfo, type PiProvider } from '../../api';
import { collectModelUniverse } from './piTabUtils';

// Owns the curated Pi model-menu draft: the saved Pi model list, selected menu
// patterns, user-touched flag, and auto-inclusion of new endpoint-declared
// models. Endpoint provider edits remain in usePiEndpoints; callers only tell
// getPatch whether provider edits should force a menu save too.
export function usePiModelMenuDraft(open: boolean, providers: PiProvider[]) {
  const [savedModels, setSavedModels] = useState<PiModelInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  // Clobber-guard (mirrors `useOverrideDraft`): `getPatch` returns the WHOLE
  // curated list, so it must stay `undefined` until the saved menu has actually
  // been read. Flips only on a successful `getPiModels()` — saving before it
  // resolves (or after it failed) would otherwise persist just the auto-added
  // endpoint patterns and drop every curated selection.
  const [loaded, setLoaded] = useState(false);
  // Patterns we've already reflected into selected — so a newly-added endpoint
  // model defaults to shown, but a model the user later unchecks doesn't get
  // auto-re-added on the next render.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setTouched(false);
    setLoaded(false);
    getPiModels()
      .then((r) => {
        if (cancelled) return;
        setSavedModels(r.models);
        setSelected(new Set(r.menu.map((m) => m.pattern)));
        seenRef.current = new Set(r.models.map((m) => m.pattern));
        setLoaded(true);
      })
      .catch(() => { /* leave current draft; `loaded` stays false so Save never writes it */ });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // The universe of selectable model patterns = saved models ∪ everything the
  // draft endpoints declare.
  const universe = useMemo(
    () => collectModelUniverse(savedModels, providers),
    [savedModels, providers],
  );

  // Auto-include any newly-appeared pattern (a model just added to a draft
  // endpoint) in the menu, so it shows in the dropdowns by default.
  useEffect(() => {
    const additions: string[] = [];
    for (const pattern of universe) {
      if (!seenRef.current.has(pattern)) {
        seenRef.current.add(pattern);
        additions.push(pattern);
      }
    }
    if (additions.length === 0) return;
    setSelected((cur) => {
      const next = new Set(cur);
      for (const pattern of additions) next.add(pattern);
      return next;
    });
  }, [universe]);

  const toggle = useCallback((pattern: string) => {
    setTouched(true);
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(pattern)) next.delete(pattern);
      else next.add(pattern);
      return next;
    });
  }, []);

  const getPatch = useCallback(
    (includeProviderEdits: boolean): string[] | undefined => {
      if (!loaded) return undefined;
      if (!includeProviderEdits && !touched) return undefined;
      return [...selected].filter((p) => universe.has(p));
    },
    [loaded, selected, touched, universe],
  );

  const patterns = useMemo(() => [...universe].sort(), [universe]);

  return { patterns, selected, toggle, getPatch };
}
