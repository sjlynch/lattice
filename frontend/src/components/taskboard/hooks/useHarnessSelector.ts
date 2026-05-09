import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchHarnessAvailability,
  fetchUserSettings,
  patchUserSettings,
  type HarnessAvailability,
} from '../../../api';

export type HarnessChoice = 'claude' | 'pi' | 'codex' | 'interleave';
export type ResolvedHarness = 'claude' | 'pi' | 'codex';

// Owns the harness selector dropdown: which agent CLIs are installed,
// the persisted per-project preference, and the round-robin pick used in
// `interleave` mode so a "Run All" produces a mix.
export function useHarnessSelector(activeFolder: string) {
  const [harness, setHarnessState] = useState<HarnessChoice>('claude');
  const interleaveNextRef = useRef<'claude' | 'pi'>('claude');
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });

  // Detect once which agent CLIs are installed. Drives whether the Pi /
  // Interleave options appear in the harness selector.
  useEffect(() => {
    let cancelled = false;
    fetchHarnessAvailability().then((avail) => {
      if (!cancelled) setHarnessAvail(avail);
    });
    return () => { cancelled = true; };
  }, []);

  // Load persisted harness preference when the active folder changes.
  // If the saved harness CLI isn't installed, coerce back to `claude` so we
  // never try to spawn an unavailable harness.
  useEffect(() => {
    if (!activeFolder) return;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (!s.harness) return;
        const unavailable =
          ((s.harness === 'pi' || s.harness === 'interleave') && !harnessAvail.pi) ||
          (s.harness === 'codex' && !harnessAvail.codex);
        if (unavailable) {
          setHarnessState('claude');
          patchUserSettings(activeFolder, { harness: 'claude' }).catch(() => {});
        } else {
          setHarnessState(s.harness);
        }
      })
      .catch(() => { /* keep default */ });
  }, [activeFolder, harnessAvail.pi, harnessAvail.codex]);

  const setHarness = useCallback((val: HarnessChoice) => {
    setHarnessState(val);
    interleaveNextRef.current = 'claude';
    if (activeFolder) patchUserSettings(activeFolder, { harness: val }).catch(() => {});
  }, [activeFolder]);

  // Resolve the harness to spawn for this run. In `interleave` mode we
  // alternate claude/pi across consecutive runs so a "Run All" produces a
  // mix; in single-mode the user's choice is used directly.
  const pickInterleaveHarness = useCallback((): ResolvedHarness => {
    if (harness !== 'interleave') return harness;
    const pick = interleaveNextRef.current;
    interleaveNextRef.current = pick === 'claude' ? 'pi' : 'claude';
    return pick;
  }, [harness]);

  return { harness, setHarness, harnessAvail, pickInterleaveHarness };
}
