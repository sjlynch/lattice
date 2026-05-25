import { useCallback, useEffect, useState } from 'react';
import {
  effectiveMetricsIgnoredExts,
  fetchUserSettings,
  patchUserSettings,
} from '../api';

// Per-project list of file extensions to skip when rendering the LOC and
// code-health overlays. Persisted via `userSettings.metricsIgnoredExts`;
// an unset value resolves to `DEFAULT_METRICS_IGNORED_EXTS` (currently
// JSON/YAML plus common prose/text extensions).
//
// The returned `save` writes both backend and local state, so the
// SettingsDialog and ForceGraphView see the new list at the same time.
export function useMetricsIgnoredExts(activeFolder: string) {
  const [exts, setExts] = useState<string[]>(() =>
    effectiveMetricsIgnoredExts(undefined),
  );

  useEffect(() => {
    if (!activeFolder) {
      setExts(effectiveMetricsIgnoredExts(undefined));
      return;
    }
    let cancelled = false;
    fetchUserSettings(activeFolder)
      .then((settings) => {
        if (cancelled) return;
        setExts(effectiveMetricsIgnoredExts(settings.metricsIgnoredExts));
      })
      .catch(() => { /* ignore — keep default */ });
    return () => {
      cancelled = true;
    };
  }, [activeFolder]);

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
