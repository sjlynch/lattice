import { useCallback, useEffect, useState } from 'react';
import {
  getPiModels,
  subscribeHarnesses,
  type HarnessAvailability,
  type PiMenuEntry,
  type WorkflowRunHarnessOverride,
} from '../../../api';

// Harness availability (which agents the backend can spawn), the curated Pi
// model menu (for per-step "Pi — X" rows), plus a map of per-workflow run-time
// overrides selected in the saved-list. Kept as one hook because the override
// picker only makes sense once availability has been fetched.
export function useWorkflowHarnessOverrides() {
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });
  const [piMenu, setPiMenu] = useState<PiMenuEntry[]>([]);
  // Per-workflow run override: the harness plus (for Pi) the chosen model. Held
  // as one object so the harness and model can't drift apart.
  const [workflowHarnessOverrides, setWorkflowHarnessOverrides] = useState<
    Record<string, { harness: WorkflowRunHarnessOverride; piModel?: string }>
  >({});

  // Live harness-availability subscription — auto-reconnects so the UI
  // catches up the moment the backend finishes its CLI probe, even when
  // the page was loaded before the server was listening.
  useEffect(() => {
    const unsub = subscribeHarnesses((avail) => {
      setHarnessAvail(avail);
    });
    return unsub;
  }, []);

  // Curated "Pi — X" menu, fetched once (machine-global). Empty → bare "Pi".
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

  const getWorkflowHarnessOverride = useCallback(
    (workflowId: string): WorkflowRunHarnessOverride =>
      workflowHarnessOverrides[workflowId]?.harness ?? null,
    [workflowHarnessOverrides],
  );

  const getWorkflowPiModelOverride = useCallback(
    (workflowId: string): string | undefined =>
      workflowHarnessOverrides[workflowId]?.piModel,
    [workflowHarnessOverrides],
  );

  const setWorkflowHarnessOverride = useCallback(
    (
      workflowId: string,
      harnessOverride: WorkflowRunHarnessOverride,
      piModel?: string,
    ) => {
      setWorkflowHarnessOverrides((cur) => ({
        ...cur,
        // Only keep a model when overriding to Pi.
        [workflowId]: {
          harness: harnessOverride,
          piModel: harnessOverride === 'pi' ? piModel : undefined,
        },
      }));
    },
    [],
  );

  return {
    harnessAvail,
    piMenu,
    workflowHarnessOverrides,
    getWorkflowHarnessOverride,
    getWorkflowPiModelOverride,
    setWorkflowHarnessOverride,
  };
}
