import { useEffect, useMemo, useState } from 'react';
import { fetchUserSettings, type UserSettings } from '../api';

// Stable identity for the no-project case so a consumer that keys an effect on
// `settings` doesn't re-run on every render.
const NO_PROJECT_SETTINGS: UserSettings = {};

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
  // What's in state is a fetch RESULT stamped with the folder it came from —
  // never bare settings. "Loading" is then derived during render by comparing
  // that stamp with the live `activeFolder`, instead of being a flag an effect
  // has to set. That distinction is the whole point: an effect runs AFTER the
  // render that changed `activeFolder`, so for one commit every consumer saw
  // `loaded: true` paired with the PREVIOUS project's settings. Sidebar width
  // and terminal-launch defaults only flickered, but App's startup-terminal
  // list is read by an effect keyed on `activeFolder` — which fired in exactly
  // that commit and spawned project A's `npm run dev` inside project B
  // (2026-08-26, apply_digital's Next server appearing in interview_eci).
  // Deriving it makes the mismatched pairing unrepresentable.
  const [fetched, setFetched] = useState<{
    folder: string;
    settings: UserSettings;
  } | null>(null);

  useEffect(() => {
    if (!activeFolder) return;
    let cancelled = false;

    fetchUserSettings(activeFolder)
      .then((settings) => {
        if (cancelled) return;
        setFetched({ folder: activeFolder, settings });
      })
      .catch(() => {
        // `fetchUserSettings` already swallows failures into `{}`; defensive only.
        if (cancelled) return;
        setFetched({ folder: activeFolder, settings: {} });
      });

    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  return useMemo<UserSettingsResult>(() => {
    if (!activeFolder) return { settings: NO_PROJECT_SETTINGS, loaded: true };
    if (!fetched || fetched.folder !== activeFolder) {
      return { settings: null, loaded: false };
    }
    return { settings: fetched.settings, loaded: true };
  }, [activeFolder, fetched]);
}
