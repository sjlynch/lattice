import { useCallback, useEffect, useState } from 'react';
import { fetchUserSettings, patchUserSettings } from '../../../api';

export type QaPlaywrightState = {
  enabled: boolean;
  headless: boolean;
};

export type QaPlaywrightControls = QaPlaywrightState & {
  onToggleEnabled: () => void;
  onToggleHeadless: () => void;
};

// Reads/persists the QA-lane Playwright MCP toggle (`userSettings.qaPlaywright`).
// Lives in userSettings (not localStorage) because the BACKEND reads it at spawn
// time to decide whether to inject the Playwright MCP. Updates are optimistic +
// patched; injection takes effect on the NEXT Claude spawn, not running agents.
export function useQaPlaywright(activeFolder: string): QaPlaywrightControls {
  const [state, setState] = useState<QaPlaywrightState>({ enabled: false, headless: true });

  useEffect(() => {
    // Reset to defaults synchronously BEFORE the fetch resolves (mirrors
    // usePostMergeHook): otherwise a project switch shows the previous
    // project's toggles until the new fetch lands, and if that fetch fails the
    // old values stick — and a later toggle would patch them onto the new
    // project.
    setState({ enabled: false, headless: true });
    if (!activeFolder) return;
    let cancelled = false;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (cancelled) return;
        setState({
          enabled: s.qaPlaywright?.enabled ?? false,
          headless: s.qaPlaywright?.headless ?? true,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

  const persist = useCallback(
    (next: QaPlaywrightState) => {
      setState(next);
      if (activeFolder) {
        // Best-effort like the optimistic toggle itself; never leave the
        // rejection unhandled.
        patchUserSettings(activeFolder, { qaPlaywright: next }).catch((err) => {
          console.warn('[lattice] saving the QA Playwright toggle failed:', err);
        });
      }
    },
    [activeFolder],
  );

  const onToggleEnabled = useCallback(
    () => persist({ ...state, enabled: !state.enabled }),
    [persist, state],
  );
  const onToggleHeadless = useCallback(
    () => persist({ ...state, headless: !state.headless }),
    [persist, state],
  );

  return { ...state, onToggleEnabled, onToggleHeadless };
}
