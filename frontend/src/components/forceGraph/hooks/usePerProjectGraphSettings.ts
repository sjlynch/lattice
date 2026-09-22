import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { loadSettings, saveSettings, type GraphSettings } from '../graphSettings';

export const SETTINGS_PERSIST_DEBOUNCE_MS = 250;

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
  // Trailing-debounced: a slider drag changes the settings per pointer move,
  // and each save is a synchronous JSON.stringify + localStorage write. The
  // pending save is flushed (not dropped) when the effect is torn down — a
  // project switch or unmount mid-drag still lands the last value.
  const pendingSaveRef = useRef<ScopedGraphSettings | null>(null);
  const flushPendingSave = useCallback(() => {
    const p = pendingSaveRef.current;
    if (!p) return;
    pendingSaveRef.current = null;
    saveSettings(p.project, p.settings);
  }, []);
  useEffect(() => {
    if (!shouldPersistScopedGraphSettings(activeFolder, scoped)) {
      // Project-switch render (or no project): the previous project's
      // debounced save lost its timer to the cleanup, so land it now under its
      // own key. Waiting for the next persist run left it unsaved when switching
      // to "no project" (which never persists) until unmount.
      flushPendingSave();
      return;
    }
    // A save still pending for ANOTHER project (a switch mid-debounce) lands
    // first, under its own key.
    if (pendingSaveRef.current && pendingSaveRef.current.project !== scoped.project) flushPendingSave();
    pendingSaveRef.current = scoped;
    const timer = setTimeout(flushPendingSave, SETTINGS_PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [activeFolder, scoped, flushPendingSave]);
  // Unmount: land whatever is still pending.
  useEffect(() => flushPendingSave, [flushPendingSave]);

  return { settings, setSettings, settingsRef };
}
