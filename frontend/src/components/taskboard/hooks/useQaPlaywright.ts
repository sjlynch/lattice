import { useCallback, useEffect, useRef, useState } from 'react';
import { patchUserSettings } from '../../../api';
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
// patched; injection takes effect on the NEXT Claude spawn, not running agents.
export function useQaPlaywright(activeFolder: string): QaPlaywrightControls {
  const [state, setState] = useState<QaPlaywrightState>(DEFAULTS);
  // The folder whose saved value `state` holds, or null while loading.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // The committed value + its folder, for the toggles: they compute `next` from
  // here rather than a render closure, so two clicks in one tick build on each
  // other, and a click can never patch one project's state onto another.
  const currentRef = useRef<{ folder: string; state: QaPlaywrightState } | null>(null);

  useEffect(() => {
    // Reset to defaults synchronously BEFORE the load resolves: otherwise a
    // project switch shows the previous project's toggles until the new load
    // lands — and a toggle would patch them onto the new project.
    currentRef.current = null;
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
        setState(loaded);
        setLoadedFor(activeFolder);
      },
      'QA Playwright',
    );
  }, [activeFolder]);

  const toggle = useCallback(
    (key: keyof QaPlaywrightState) => {
      const cur = currentRef.current;
      if (!activeFolder || !cur || cur.folder !== activeFolder) return;
      const next = { ...cur.state, [key]: !cur.state[key] };
      currentRef.current = { folder: activeFolder, state: next };
      setState(next);
      // The PATCH merge is shallow, so `qaPlaywright` goes whole — but built
      // from the LOADED value, so the untouched field keeps what was saved.
      // Best-effort like the optimistic toggle itself; never leave the
      // rejection unhandled.
      patchUserSettings(activeFolder, { qaPlaywright: next }).catch((err) => {
        console.warn('[lattice] saving the QA Playwright toggle failed:', err);
      });
    },
    [activeFolder],
  );

  const onToggleEnabled = useCallback(() => toggle('enabled'), [toggle]);
  const onToggleHeadless = useCallback(() => toggle('headless'), [toggle]);

  const loaded = !!activeFolder && loadedFor === activeFolder;
  return { ...(loaded ? state : DEFAULTS), loaded, onToggleEnabled, onToggleHeadless };
}
