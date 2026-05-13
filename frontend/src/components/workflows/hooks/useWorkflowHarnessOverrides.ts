import { useCallback, useEffect, useState } from 'react';
import {
  fetchHarnessAvailability,
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

  useEffect(() => {
    let cancelled = false;
    fetchHarnessAvailability().then((avail) => {
      if (!cancelled) setHarnessAvail(avail);
    });
    return () => { cancelled = true; };
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
