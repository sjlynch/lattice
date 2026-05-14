import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUserSettings,
  patchUserSettings,
  subscribeHarnesses,
  type HarnessAvailability,
} from '../../../api';
import { isHarnessChoice, type AgentHarness, type HarnessChoice } from '../../../harnesses';

export type { HarnessChoice };
export type ResolvedHarness = AgentHarness;

// Owns the harness selector dropdown: which agent CLIs are installed,
// the persisted per-project preference, and the round-robin pick used in
// `interleave` mode so a "Run All" produces a mix.
export function useHarnessSelector(activeFolder: string) {
  const [harness, setHarnessState] = useState<HarnessChoice>('claude');
  const interleaveNextRef = useRef<AgentHarness>('claude');
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });
  // Until the backend has told us which CLIs are installed, defer the
  // coerce-unavailable logic below — otherwise a slow-booting server
  // would let us overwrite the saved `pi`/`codex` preference with
  // `claude` and persist that to disk.
  const [harnessAvailLoaded, setHarnessAvailLoaded] = useState(false);

  // Live harness-availability subscription. The backend pushes the
  // current `{claude, pi, codex}` map as soon as CLI detection
  // completes; the WS auto-reconnects so this also handles the case
  // where the page was loaded before the server was listening.
  useEffect(() => {
    const unsub = subscribeHarnesses((avail) => {
      setHarnessAvail(avail);
      setHarnessAvailLoaded(true);
    });
    return unsub;
  }, []);

  // Load persisted harness preference when the active folder changes.
  // If the saved harness CLI isn't installed, coerce back to `claude` so we
  // never try to spawn an unavailable harness.
  useEffect(() => {
    if (!activeFolder) return;
    if (!harnessAvailLoaded) return;
    fetchUserSettings(activeFolder)
      .then((s) => {
        if (!isHarnessChoice(s.harness)) return;
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
  }, [activeFolder, harnessAvailLoaded, harnessAvail.pi, harnessAvail.codex]);

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
