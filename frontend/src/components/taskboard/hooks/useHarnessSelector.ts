import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchUserSettings,
  patchUserSettings,
  type PiMenuEntry,
} from '../../../api';
import { useHarnessAvailability } from '../../../hooks/useHarnessAvailability';
import { usePiModelMenu } from '../../../hooks/usePiModelMenu';
import {
  decodeHarnessValue,
  type AgentHarness,
  type HarnessChoice,
} from '../../../harnesses';
import { loadHarnessForFolder } from './harnessSelectorLoad';

export type { HarnessChoice };
export type ResolvedHarness = AgentHarness;
// What a run/resume needs: the harness plus (for Pi) the chosen model.
export type RunHarnessSelection = { harness: AgentHarness; piModel?: string };
export type { PiMenuEntry };

// Owns the harness selector dropdown: which agent CLIs are installed, the
// curated Pi model menu, the persisted per-project preference ({harness,
// piModel}), and the round-robin pick used in `interleave` mode so a "Run All"
// produces a mix. Availability + the Pi menu come from the shared hooks
// (`useHarnessAvailability` / `usePiModelMenu`); this hook keeps only the
// selection/persistence that's specific to the task board.
export function useHarnessSelector(activeFolder: string) {
  const [harness, setHarnessState] = useState<HarnessChoice>('claude');
  // Selected Pi model ("provider/model"); undefined = Pi's own default.
  const [piModel, setPiModelState] = useState<string | undefined>(undefined);
  const interleaveNextRef = useRef<AgentHarness>('claude');
  const { harnessAvail, harnessAvailLoaded } = useHarnessAvailability();
  const piMenu = usePiModelMenu();
  // Monotonic load id: each folder-change load claims the next id; a resolved
  // fetch only applies if it's still the latest (the fast-project-switch guard).
  const loadSeqRef = useRef(0);

  // Load persisted harness + piModel when the active folder changes. If the
  // saved harness CLI isn't installed, coerce back to `claude`. A load that
  // resolves after the user has already switched folders is dropped so it can't
  // overwrite the newer project's selection (see `loadHarnessForFolder`).
  useEffect(() => {
    if (!activeFolder) return;
    if (!harnessAvailLoaded) return;
    const seq = ++loadSeqRef.current;
    void loadHarnessForFolder(activeFolder, harnessAvail, {
      fetchUserSettings,
      patchUserSettings,
      isStale: () => loadSeqRef.current !== seq,
      setHarness: setHarnessState,
      setPiModel: setPiModelState,
    });
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
