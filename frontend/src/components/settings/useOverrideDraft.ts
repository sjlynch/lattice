import { useCallback, useEffect, useState } from 'react';
import { fetchUserSettings, type UserSettings } from '../../api';

// Shared draft engine behind the two "override-merge" settings tabs
// (InstructionTemplatesTab + EnvNotesTab). Both own the same shape — a list of
// items, an editable text draft per item, the raw saved override map, and a
// loaded flag — and both persist by cloning the saved overrides then, per item,
// either dropping the key (draft means "use Lattice's default") or writing the
// edited text. Those clobber-guard + override-merge semantics are the bit that
// gets subtly broken when copy-pasted (see settings/CLAUDE.md "Shared tab
// pattern"), so they live here once. The two real per-tab differences are
// parameters: `fetchItems` (each tab fetches its own catalog) and
// `matchesDefault` (instruction templates drop on blank-or-exact-default; env
// notes drop on trimmed equality).

export type OverrideDraftConfig<T> = {
  // Fetch only when the dialog is open, this tab is active, and a project is
  // selected. Re-seeds on reopen / tab re-activation / project change (unsaved
  // edits are dropped on re-seed, matching the prior per-tab hooks).
  open: boolean;
  active: boolean;
  activeFolder: string;
  // Fetch this tab's items (instruction templates / detected envs).
  fetchItems: (projectPath: string) => Promise<T[]>;
  // Pull this tab's saved override map out of the fetched user settings.
  readOverrides: (settings: UserSettings) => Record<string, string>;
  // Stable key for an item — the key in both the draft map and the override map.
  idOf: (item: T) => string;
  // Lattice's built-in default text for an item.
  defaultOf: (item: T) => string;
  // The project's current (override-or-default) text — seeds the draft.
  currentOf: (item: T) => string;
  // True when a draft should NOT be persisted as an override (it equals the
  // default / is blank → drop the key, falling back to Lattice's default). This
  // is the one semantic divergence between the tabs.
  matchesDefault: (draft: string, item: T) => boolean;
};

export type OverrideDraft<T> = {
  items: T[];
  draftMap: Record<string, string>;
  loading: boolean;
  error: string | null;
  setDraft: (id: string, text: string) => void;
  resetDraft: (item: T) => void;
  resetAll: () => void;
  // The full desired override map to persist, or `undefined` until the seeding
  // fetch has completed. That `undefined` is the clobber-guard: a Save before
  // the load finishes must not rewrite overrides this tab never actually edited.
  getPatch: () => Record<string, string> | undefined;
};

export function useOverrideDraft<T>(config: OverrideDraftConfig<T>): OverrideDraft<T> {
  const {
    open,
    active,
    activeFolder,
    fetchItems,
    readOverrides,
    idOf,
    defaultOf,
    currentOf,
    matchesDefault,
  } = config;

  const [items, setItems] = useState<T[]>([]);
  const [draftMap, setDraftMap] = useState<Record<string, string>>({});
  const [existingOverrides, setExistingOverrides] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !active || !activeFolder) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    Promise.all([fetchItems(activeFolder), fetchUserSettings(activeFolder)])
      .then(([list, settings]) => {
        if (cancelled) return;
        setItems(list);
        setDraftMap(Object.fromEntries(list.map((item) => [idOf(item), currentOf(item)])));
        setExistingOverrides(readOverrides(settings));
        // Only flip `loaded` on success — a failed fetch leaves the clobber-
        // guard armed so getPatch() returns undefined instead of an empty map.
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message || 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // fetchItems / idOf / etc. are stable module-level fns; re-seed only on
    // open / tab activation / project change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, activeFolder]);

  const setDraft = useCallback((id: string, text: string) => {
    setDraftMap((d) => ({ ...d, [id]: text }));
  }, []);

  const resetDraft = useCallback(
    (item: T) => {
      setDraftMap((d) => ({ ...d, [idOf(item)]: defaultOf(item) }));
    },
    [idOf, defaultOf],
  );

  const resetAll = useCallback(() => {
    setDraftMap(Object.fromEntries(items.map((item) => [idOf(item), defaultOf(item)])));
  }, [items, idOf, defaultOf]);

  // Build the map to persist: keep overrides for ids we don't manage, then for
  // each item drop the key when the draft matches the default (or is blank),
  // else store the edited text.
  const getPatch = useCallback((): Record<string, string> | undefined => {
    if (!loaded) return undefined;
    const next: Record<string, string> = { ...existingOverrides };
    for (const item of items) {
      const id = idOf(item);
      const draft = draftMap[id] ?? currentOf(item);
      if (matchesDefault(draft, item)) {
        delete next[id];
      } else {
        next[id] = draft;
      }
    }
    return next;
  }, [loaded, existingOverrides, items, draftMap, idOf, currentOf, matchesDefault]);

  return { items, draftMap, loading, error, setDraft, resetDraft, resetAll, getPatch };
}
