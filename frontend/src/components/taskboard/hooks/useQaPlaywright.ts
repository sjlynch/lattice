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
      if (activeFolder) void patchUserSettings(activeFolder, { qaPlaywright: next });
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
