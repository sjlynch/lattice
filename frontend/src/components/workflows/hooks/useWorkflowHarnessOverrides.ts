import { useCallback, useState } from 'react';
import { type WorkflowRunHarnessOverride } from '../../../api';
import { useHarnessAvailability } from '../../../hooks/useHarnessAvailability';
import { usePiModelMenu } from '../../../hooks/usePiModelMenu';

// Harness availability (which agents the backend can spawn), the curated Pi
// model menu (for per-step "Pi — X" rows), plus a map of per-workflow run-time
// overrides selected in the saved-list. Availability + the Pi menu come from the
// shared hooks; this hook keeps only the per-workflow override map.
export function useWorkflowHarnessOverrides() {
  const { harnessAvail } = useHarnessAvailability();
  const piMenu = usePiModelMenu();
  // Per-workflow run override: the harness plus (for Pi) the chosen model. Held
  // as one object so the harness and model can't drift apart.
  const [workflowHarnessOverrides, setWorkflowHarnessOverrides] = useState<
    Record<string, { harness: WorkflowRunHarnessOverride; piModel?: string }>
  >({});

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
