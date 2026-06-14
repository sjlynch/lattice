import { useEffect, useState } from 'react';
import { fetchUserSettings, type UserSettings } from '../api';

export type UserSettingsResult = {
  // The fetched settings for the current `activeFolder`, or `null` until the
  // fetch settles. Consumers gate on `loaded` (or this being non-null) so they
  // never apply the previous folder's stale settings during a switch.
  settings: UserSettings | null;
  // True once we have a definitive answer for the current folder — the fetch
  // settled (success, or `{}` since `fetchUserSettings` swallows failures), or
  // there is no active folder.
  loaded: boolean;
};

// Single per-folder fetch of `userSettings.json`, shared by the hooks that each
// need a different slice (sidebar width, startup terminals, metrics-ignored
// exts) plus App's terminal-launch defaults. Previously each consumer fetched
// the same file independently — several identical GETs and setState cascades
// for one logical fetch per folder switch. Lifted once at the App level; each
// consumer reads its slice from the result instead of fetching on its own.
//
// Deliberately not cached across folder switches: re-fetching on every
// `activeFolder` change keeps consumers in sync with values they `PATCH`ed
// while a different folder was active (same freshness as the old per-hook
// fetches).
export function useUserSettings(activeFolder: string): UserSettingsResult {
  const [result, setResult] = useState<UserSettingsResult>(() =>
    activeFolder
      ? { settings: null, loaded: false }
      : { settings: {}, loaded: true },
  );

  useEffect(() => {
    let cancelled = false;

    if (!activeFolder) {
      setResult({ settings: {}, loaded: true });
      return () => {
        cancelled = true;
      };
    }

    // New folder: mark as loading so consumers hold their current values until
    // this folder's settings arrive.
    setResult({ settings: null, loaded: false });

    fetchUserSettings(activeFolder)
      .then((settings) => {
        if (cancelled) return;
        setResult({ settings, loaded: true });
      })
      .catch(() => {
        // `fetchUserSettings` already swallows failures into `{}`; defensive only.
        if (cancelled) return;
        setResult({ settings: {}, loaded: true });
      });

    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  return result;
}
