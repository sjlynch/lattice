import { useCallback, useEffect, useState } from 'react';
import type { StartupTerminal } from '../api';
import type { UserSettingsResult } from './useUserSettings';

// Stable identity so a consumer keying an effect on the returned list doesn't
// re-run on every render while a project's settings are still in flight.
const NONE: StartupTerminal[] = [];

export function useStartupTerminalSync(
  activeFolder: string,
  userSettings: UserSettingsResult,
) {
  // Startup terminals are per-project, loaded from userSettings.json. Sidebar
  // owns the "ensure spawned" + "restart" lifecycle; App just holds the list
  // so SettingsDialog can edit it and Sidebar can react to changes. The
  // userSettings fetch is shared via useUserSettings (see App); we read our
  // slice from it.
  //
  // The list is STAMPED with the project it belongs to, and a stamp that
  // doesn't match `activeFolder` reads as "nothing to spawn yet" rather than
  // as the previous project's list. Holding the old value across the switch
  // was actively dangerous here, unlike for sidebar width: Sidebar's spawn
  // effect keys on `activeFolder`, so the moment the folder changed it fired
  // with the NEW cwd and the OLD commands and launched project A's dev server
  // inside project B (2026-08-26 — apply_digital's `npx next dev -p 3005`
  // running in interview_eci). An empty list just spawns nothing until this
  // project's settings land a moment later.
  const [entry, setEntry] = useState<{
    folder: string;
    list: StartupTerminal[];
  }>({ folder: activeFolder, list: NONE });

  const { settings, loaded } = userSettings;

  useEffect(() => {
    if (!activeFolder) {
      setEntry({ folder: '', list: NONE });
      return;
    }
    if (!loaded || !settings) return; // wait for this folder's settings
    setEntry({ folder: activeFolder, list: settings.startupTerminals ?? NONE });
  }, [activeFolder, loaded, settings]);

  // SettingsDialog's save path writes the freshly-saved list straight back.
  // Stamp it with the folder that was active for that save, so a save landing
  // just after a project switch can't hand the new project the old one's list.
  const setStartupTerminals = useCallback(
    (next: StartupTerminal[]) => setEntry({ folder: activeFolder, list: next }),
    [activeFolder],
  );

  const startupTerminals = entry.folder === activeFolder ? entry.list : NONE;

  return [startupTerminals, setStartupTerminals] as const;
}
