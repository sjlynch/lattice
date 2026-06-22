import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUserSettings,
  getPiModels,
  patchUserSettings,
  subscribeHarnesses,
  type HarnessAvailability,
  type PiMenuEntry,
} from '../../../api';
import {
  decodeHarnessValue,
  isHarnessChoice,
  type AgentHarness,
  type HarnessChoice,
} from '../../../harnesses';

export type { HarnessChoice };
export type ResolvedHarness = AgentHarness;
// What a run/resume needs: the harness plus (for Pi) the chosen model.
export type RunHarnessSelection = { harness: AgentHarness; piModel?: string };

// Owns the harness selector dropdown: which agent CLIs are installed, the
// curated Pi model menu, the persisted per-project preference ({harness,
// piModel}), and the round-robin pick used in `interleave` mode so a "Run All"
// produces a mix.
export function useHarnessSelector(activeFolder: string) {
  const [harness, setHarnessState] = useState<HarnessChoice>('claude');
  // Selected Pi model ("provider/model"); undefined = Pi's own default.
  const [piModel, setPiModelState] = useState<string | undefined>(undefined);
  const interleaveNextRef = useRef<AgentHarness>('claude');
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });
  const [piMenu, setPiMenu] = useState<PiMenuEntry[]>([]);
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

  // The curated "Pi — X" menu. Machine-global, so fetched once (not per
  // folder). Best-effort: an empty menu just means only bare "Pi" shows.
  useEffect(() => {
    let alive = true;
    getPiModels()
      .then((r) => {
        if (alive) setPiMenu(r.menu);
      })
      .catch(() => { /* keep empty */ });
    return () => {
      alive = false;
    };
  }, []);

  // Load persisted harness + piModel when the active folder changes. If the
  // saved harness CLI isn't installed, coerce back to `claude` so we never
  // try to spawn an unavailable harness.
  useEffect(() => {
    if (!activeFolder) return;
    if (!harnessAvailLoaded) return;
    fetchUserSettings(activeFolder)
      .then((s) => {
        setPiModelState(s.piModel || undefined);
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

  // Handle a dropdown change. The encoded value carries both the harness and
  // (for a "Pi — X" row) the model; we decode, update state, and persist.
  const selectHarness = useCallback(
    (value: string) => {
      const sel = decodeHarnessValue(value);
      setHarnessState(sel.harness);
      interleaveNextRef.current = 'claude';
      // Bare "Pi" clears the model (→ Pi default); a specific row sets it.
      // Non-Pi / interleave selections leave the stored model untouched so it
      // survives a round-trip through Claude (and feeds interleave's Pi pick).
      let nextPiModel = piModel;
      const patch: Parameters<typeof patchUserSettings>[1] = { harness: sel.harness };
      if (sel.harness === 'pi') {
        nextPiModel = sel.piModel;
        patch.piModel = sel.piModel ?? '';
      }
      setPiModelState(nextPiModel);
      if (activeFolder) patchUserSettings(activeFolder, patch).catch(() => {});
    },
    [activeFolder, piModel],
  );

  // Resolve the harness + model to spawn for this run. In `interleave` mode we
  // alternate claude/pi across consecutive runs so a "Run All" produces a mix;
  // interleave's Pi pick uses the stored default model.
  const pickRunHarness = useCallback((): RunHarnessSelection => {
    if (harness !== 'interleave') {
      return { harness, piModel: harness === 'pi' ? piModel || undefined : undefined };
    }
    const pick = interleaveNextRef.current;
    interleaveNextRef.current = pick === 'claude' ? 'pi' : 'claude';
    return { harness: pick, piModel: pick === 'pi' ? piModel || undefined : undefined };
  }, [harness, piModel]);

  return { harness, piModel, piMenu, selectHarness, harnessAvail, pickRunHarness };
}
