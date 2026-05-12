import { useEffect, useState } from 'react';
import { fetchUserSettings, type StartupTerminal } from '../api';

export function useStartupTerminalSync(activeFolder: string) {
  // Startup terminals are per-project, loaded from userSettings.json. Sidebar
  // owns the "ensure spawned" + "restart" lifecycle; App just holds the list
  // so SettingsDialog can edit it and Sidebar can react to changes.
  const [startupTerminals, setStartupTerminals] = useState<StartupTerminal[]>([]);

  useEffect(() => {
    if (!activeFolder) {
      setStartupTerminals([]);
      return;
    }
    fetchUserSettings(activeFolder)
      .then((settings) => {
        setStartupTerminals(settings.startupTerminals ?? []);
      })
      .catch(() => { /* ignore — keep current terminals */ });
  }, [activeFolder]);

  return [startupTerminals, setStartupTerminals] as const;
}
