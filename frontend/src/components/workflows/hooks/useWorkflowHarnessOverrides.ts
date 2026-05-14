import { useCallback, useEffect, useState } from 'react';
import {
  subscribeHarnesses,
  type HarnessAvailability,
  type WorkflowRunHarnessOverride,
} from '../../../api';

// Harness availability (which agents the backend can spawn) plus a map of
// per-workflow run-time overrides selected in the saved-list. Kept as one
// hook because the override picker only makes sense once availability has
// been fetched.
export function useWorkflowHarnessOverrides() {
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });
  const [workflowHarnessOverrides, setWorkflowHarnessOverrides] = useState<
    Record<string, WorkflowRunHarnessOverride>
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

  const getWorkflowHarnessOverride = useCallback(
    (workflowId: string): WorkflowRunHarnessOverride =>
      workflowHarnessOverrides[workflowId] ?? null,
    [workflowHarnessOverrides],
  );

  const setWorkflowHarnessOverride = useCallback(
    (workflowId: string, harnessOverride: WorkflowRunHarnessOverride) => {
      setWorkflowHarnessOverrides((cur) => ({
        ...cur,
        [workflowId]: harnessOverride,
      }));
    },
    [],
  );

  return {
    harnessAvail,
    workflowHarnessOverrides,
    getWorkflowHarnessOverride,
    setWorkflowHarnessOverride,
  };
}
