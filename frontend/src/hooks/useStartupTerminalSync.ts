import { useEffect, useState } from 'react';
import type { StartupTerminal } from '../api';
import type { UserSettingsResult } from './useUserSettings';

export function useStartupTerminalSync(
  activeFolder: string,
  userSettings: UserSettingsResult,
) {
  // Startup terminals are per-project, loaded from userSettings.json. Sidebar
  // owns the "ensure spawned" + "restart" lifecycle; App just holds the list
  // so SettingsDialog can edit it and Sidebar can react to changes. The
  // userSettings fetch is shared via useUserSettings (see App); we read our
  // slice from it.
  const [startupTerminals, setStartupTerminals] = useState<StartupTerminal[]>([]);
  const { settings, loaded } = userSettings;

  useEffect(() => {
    if (!activeFolder) {
      setStartupTerminals([]);
      return;
    }
    if (!loaded || !settings) return; // wait for this folder's settings
    setStartupTerminals(settings.startupTerminals ?? []);
  }, [activeFolder, loaded, settings]);

  return [startupTerminals, setStartupTerminals] as const;
}
