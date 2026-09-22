import { useCallback, useEffect, useState } from 'react';
import { fetchDefaultRoot } from '../api';
import { APP_CONFIG } from '../appConfig';
import { canonicalProjectPath } from '../projectPath';
import { resolveDefaultRoot } from './resolveDefaultRoot';

function readStoredActiveFolder(): string {
  try {
    return canonicalProjectPath(
      sessionStorage.getItem(APP_CONFIG.storage.activeFolderSessionKey) ?? '',
    );
  } catch {
    return '';
  }
}

export function useActiveFolder() {
  // Seed from sessionStorage synchronously so the persist effect below doesn't
  // wipe the stored value before the loader effect reads it. Effects run in
  // declaration order, and the persist effect fires first — if activeFolder
  // started as '' it would call sessionStorage.removeItem(...) and the per-tab
  // active-folder memory would be lost on every mount.
  const [activeFolder, setActiveFolderRaw] = useState<string>(readStoredActiveFolder);
  // Always canonicalize what we store as activeFolder so per-project keys
  // (terminals filter, settings, hidden-exts) match the canonical form the
  // backend uses for task.projectPath. Keeps a non-canonical path picked
  // via the folder browser from diverging from a task's projectPath.
  const setActiveFolder = useCallback((next: string) => {
    setActiveFolderRaw(canonicalProjectPath(next));
  }, []);

  useEffect(() => {
    if (activeFolder) {
      const name = activeFolder.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? activeFolder;
      document.title = `${name} — Lattice`;
    } else {
      document.title = 'Lattice';
    }
  }, [activeFolder]);

  // Persist the active folder per-tab so refreshing keeps the chosen project,
  // letting multiple Lattice tabs each track their own working directory.
  useEffect(() => {
    try {
      if (activeFolder) {
        sessionStorage.setItem(APP_CONFIG.storage.activeFolderSessionKey, activeFolder);
      } else {
        sessionStorage.removeItem(APP_CONFIG.storage.activeFolderSessionKey);
      }
    } catch {
      /* ignore */
    }
  }, [activeFolder]);

  // If the tab had no stored folder (fresh tab), fall back to the backend's
  // default project. The stored case is already handled by the useState seed
  // above, so we only call fetchDefaultRoot when activeFolder is still empty.
  // A boot-time failure (the backend still starting → a 502/parse error) is
  // transient: retry with backoff rather than permanently clearing to '' and
  // stranding the user on a blank shell. resolveDefaultRoot resolves to '' only
  // once retries are exhausted, which is the same empty-shell fallback as before.
  useEffect(() => {
    if (activeFolder) return;
    let cancelled = false;
    resolveDefaultRoot({
      fetchRoot: fetchDefaultRoot,
      isCancelled: () => cancelled,
      onRetry: (err, attempt) =>
        console.warn(`default-root fetch failed (retry ${attempt + 1})`, err),
    }).then((root) => {
      // Only fill a still-empty folder: the retry loop can run ~19 s during a
      // backend restart, and a project the user picked meanwhile must win —
      // a late default (or the '' of exhausted retries) used to replace it.
      if (!cancelled) setActiveFolderRaw((cur) => cur || canonicalProjectPath(root));
    });
    return () => {
      cancelled = true;
    };
    // Only run on mount — once the user picks a folder we don't want to keep
    // refetching the default if they later clear it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [activeFolder, setActiveFolder] as const;
}
