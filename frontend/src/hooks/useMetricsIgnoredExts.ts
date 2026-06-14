import { useCallback, useEffect, useState } from 'react';
import {
  effectiveMetricsIgnoredExts,
  patchUserSettings,
} from '../api';
import type { UserSettingsResult } from './useUserSettings';

// Per-project list of file extensions to skip when rendering the LOC and
// code-health overlays. Persisted via `userSettings.metricsIgnoredExts`;
// an unset value resolves to `DEFAULT_METRICS_IGNORED_EXTS` (currently
// JSON/YAML plus common prose/text extensions). The userSettings fetch is
// shared via useUserSettings (see App); we read our slice from it.
//
// The returned `save` writes both backend and local state, so the
// SettingsDialog and ForceGraphView see the new list at the same time.
export function useMetricsIgnoredExts(
  activeFolder: string,
  userSettings: UserSettingsResult,
) {
  const [exts, setExts] = useState<string[]>(() =>
    effectiveMetricsIgnoredExts(undefined),
  );
  const { settings, loaded } = userSettings;

  useEffect(() => {
    if (!activeFolder) {
      setExts(effectiveMetricsIgnoredExts(undefined));
      return;
    }
    if (!loaded || !settings) return; // wait for this folder's settings
    setExts(effectiveMetricsIgnoredExts(settings.metricsIgnoredExts));
  }, [activeFolder, loaded, settings]);

  const save = useCallback(
    async (next: string[]) => {
      setExts(next);
      if (!activeFolder) return;
      await patchUserSettings(activeFolder, { metricsIgnoredExts: next });
    },
    [activeFolder],
  );

  return [exts, save] as const;
}
