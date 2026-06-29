import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { loadSettings, saveSettings, type GraphSettings } from '../graphSettings';

export type ScopedGraphSettings = {
  project: string;
  settings: GraphSettings;
};

export function scopedGraphSettingsForProject(project: string): ScopedGraphSettings {
  return { project, settings: loadSettings(project) };
}

export function settingsForActiveProject(
  activeFolder: string,
  scoped: ScopedGraphSettings,
): GraphSettings {
  return scoped.project === activeFolder
    ? scoped.settings
    : loadSettings(activeFolder);
}

export function shouldPersistScopedGraphSettings(
  activeFolder: string,
  scoped: ScopedGraphSettings,
): boolean {
  return !!activeFolder && scoped.project === activeFolder;
}

function resolveSettingsAction(
  action: SetStateAction<GraphSettings>,
  previous: GraphSettings,
): GraphSettings {
  return typeof action === 'function'
    ? (action as (prev: GraphSettings) => GraphSettings)(previous)
    : action;
}

export function usePerProjectGraphSettings(activeFolder: string) {
  const [scoped, setScoped] = useState<ScopedGraphSettings>(() =>
    scopedGraphSettingsForProject(activeFolder),
  );
  const settings = useMemo(
    () => settingsForActiveProject(activeFolder, scoped),
    [activeFolder, scoped],
  );
  const settingsRef = useRef<GraphSettings>(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Reload persisted settings when the active project changes. Until this effect
  // lands, `settings` above is computed from the new project key, while the
  // tagged state still points at the old project so the persist effect skips.
  useEffect(() => {
    setScoped((prev) =>
      prev.project === activeFolder ? prev : scopedGraphSettingsForProject(activeFolder),
    );
  }, [activeFolder]);

  const setSettings = useCallback(
    (next: SetStateAction<GraphSettings>) => {
      setScoped((prev) => {
        const previousSettings = settingsForActiveProject(activeFolder, prev);
        return {
          project: activeFolder,
          settings: resolveSettingsAction(next, previousSettings),
        };
      });
    },
    [activeFolder],
  );

  // Persist only settings that are tagged with the currently-active project.
  // This prevents the project-switch render where project B is active but the
  // state object still belongs to project A from stamping A's settings under B.
  useEffect(() => {
    if (!shouldPersistScopedGraphSettings(activeFolder, scoped)) return;
    saveSettings(activeFolder, scoped.settings);
  }, [activeFolder, scoped]);

  return { settings, setSettings, settingsRef };
}
