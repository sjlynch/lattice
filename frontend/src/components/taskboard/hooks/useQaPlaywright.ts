import { useCallback, useEffect, useRef, useState } from 'react';
import { patchUserSettings } from '../../../api';
import { saveOptimistic } from './optimisticSave';
import { loadUserSettingsWithRetry } from './strictSettingsLoad';

export type QaPlaywrightState = {
  enabled: boolean;
  headless: boolean;
};

export type QaPlaywrightControls = QaPlaywrightState & {
  // False until this project's saved toggle has actually loaded. The buttons
  // are disabled meanwhile and the toggles are no-ops, so nothing is ever
  // written over a value we haven't read.
  loaded: boolean;
  onToggleEnabled: () => void;
  onToggleHeadless: () => void;
};

const DEFAULTS: QaPlaywrightState = { enabled: false, headless: true };

// Reads/persists the QA-lane Playwright MCP toggle (`userSettings.qaPlaywright`).
// Lives in userSettings (not localStorage) because the BACKEND reads it at spawn
// time to decide whether to inject the Playwright MCP. Updates are optimistic +
// patched, and a failed PATCH reverts the toggle and toasts (the backend kept
// the old value, so the next QA run would not match the board otherwise);
// injection takes effect on the NEXT Claude spawn, not running agents.
export function useQaPlaywright(
  activeFolder: string,
  showError: (msg: string) => void,
): QaPlaywrightControls {
  const [state, setState] = useState<QaPlaywrightState>(DEFAULTS);
  // The folder whose saved value `state` holds, or null while loading.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // The committed value + its folder, for the toggles: they compute `next` from
  // here rather than a render closure, so two clicks in one tick build on each
  // other, and a click can never patch one project's state onto another.
  const currentRef = useRef<{ folder: string; state: QaPlaywrightState } | null>(null);
  // The value the backend last loaded or acknowledged for this load — what a
  // failed toggle reverts to. A fresh object per load, so a save that settles
  // after a project switch (even back to the same project) can't touch it.
  const confirmedRef = useRef<{ folder: string; state: QaPlaywrightState } | null>(null);

  useEffect(() => {
    // Reset to defaults synchronously BEFORE the load resolves: otherwise a
    // project switch shows the previous project's toggles until the new load
    // lands — and a toggle would patch them onto the new project.
    currentRef.current = null;
    confirmedRef.current = null;
    setState(DEFAULTS);
    setLoadedFor(null);
    if (!activeFolder) return;
    // Strict + retried: a failed load (a 502 mid backend restart) keeps the
    // toggles disabled instead of standing in as "saved: off, headless".
    return loadUserSettingsWithRetry(
      activeFolder,
      (s) => {
        const loaded = {
          enabled: s.qaPlaywright?.enabled ?? DEFAULTS.enabled,
          headless: s.qaPlaywright?.headless ?? DEFAULTS.headless,
        };
        currentRef.current = { folder: activeFolder, state: loaded };
        confirmedRef.current = { folder: activeFolder, state: loaded };
        setState(loaded);
        setLoadedFor(activeFolder);
      },
      'QA Playwright',
    );
  }, [activeFolder]);

  const toggle = useCallback(
    (key: keyof QaPlaywrightState) => {
      const cur = currentRef.current;
      const confirmed = confirmedRef.current;
      if (!activeFolder || !cur || cur.folder !== activeFolder) return;
      if (!confirmed || confirmed.folder !== activeFolder) return;
      const folder = activeFolder;
      const next = { ...cur.state, [key]: !cur.state[key] };
      // The PATCH merge is shallow, so `qaPlaywright` goes whole — but built
      // from the LOADED value, so the untouched field keeps what was saved.
      void saveOptimistic(next, {
        persist: (value) => patchUserSettings(folder, { qaPlaywright: value }),
        apply: (value) => {
          currentRef.current = { folder, state: value };
          setState(value);
        },
        // A later toggle sends the whole object too, so its outcome wins.
        isCurrent: () => confirmedRef.current === confirmed && currentRef.current?.state === next,
        previous: () => confirmed.state,
        onSaved: (value) => {
          confirmed.state = value;
        },
        onError: (err) =>
          showError(`Saving the QA Playwright toggle failed: ${(err as Error).message}`),
      });
    },
    [activeFolder, showError],
  );

  const onToggleEnabled = useCallback(() => toggle('enabled'), [toggle]);
  const onToggleHeadless = useCallback(() => toggle('headless'), [toggle]);

  const loaded = !!activeFolder && loadedFor === activeFolder;
  return { ...(loaded ? state : DEFAULTS), loaded, onToggleEnabled, onToggleHeadless };
}
