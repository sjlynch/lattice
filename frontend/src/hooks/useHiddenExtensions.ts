import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APP_CONFIG } from '../appConfig';
import { reconcileHiddenExtsPersist } from './hiddenExtsPersist';

export function useHiddenExtensions(activeFolder: string) {
  // Per-extension visibility, persisted per project. Stored as a list of
  // hidden ext keys (e.g., ['.json', '.md']).
  const [hiddenExts, setHiddenExts] = useState<Set<string>>(new Set());

  const hiddenExtsKey = useMemo(
    () =>
      activeFolder
        ? `${APP_CONFIG.storage.hiddenExtsKeyPrefix}${activeFolder}`
        : null,
    [activeFolder],
  );

  // Load hidden-exts for the active folder
  useEffect(() => {
    if (!hiddenExtsKey) {
      setHiddenExts(new Set());
      return;
    }
    try {
      const raw = localStorage.getItem(hiddenExtsKey);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          setHiddenExts(new Set(arr.map(String)));
          return;
        }
      }
    } catch {
      /* ignore */
    }
    setHiddenExts(new Set());
  }, [hiddenExtsKey]);

  // Persist genuine mutations only. On a folder switch the key changes a render
  // before the load effect above repopulates `hiddenExts` for the new project,
  // so `hiddenExts` momentarily still holds the PREVIOUS project's set; writing
  // it then would stamp project A's hidden set onto project B's key. The guard
  // skips the write on the render where the key just changed (see
  // reconcileHiddenExtsPersist); the next render persists the correct value.
  const persistedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const { write, nextKey } = reconcileHiddenExtsPersist(
      hiddenExtsKey,
      persistedKeyRef.current,
    );
    persistedKeyRef.current = nextKey;
    if (!write || !hiddenExtsKey) return;
    try {
      localStorage.setItem(hiddenExtsKey, JSON.stringify(Array.from(hiddenExts)));
    } catch {
      /* ignore */
    }
  }, [hiddenExts, hiddenExtsKey]);

  const toggleExt = useCallback((key: string) => {
    setHiddenExts((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return { hiddenExts, toggleExt };
}
