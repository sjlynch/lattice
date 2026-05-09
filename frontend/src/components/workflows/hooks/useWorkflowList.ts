import { useEffect, useMemo, useState } from 'react';
import { fetchWorkflows, subscribeWorkflows, type Workflow } from '../../../api';

// Hydrates the saved workflow list for a project and keeps it in sync via
// the `/ws/workflows` subscription.
export function useWorkflowList(activeFolder: string) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);

  useEffect(() => {
    if (!activeFolder) {
      setWorkflows([]);
      return;
    }
    let cancelled = false;
    fetchWorkflows(activeFolder)
      .then((ws) => { if (!cancelled) setWorkflows(ws); })
      .catch((err) => console.error('fetchWorkflows', err));
    const unsub = subscribeWorkflows(activeFolder, (ws) => {
      if (!cancelled) setWorkflows(ws);
    });
    return () => { cancelled = true; unsub(); };
  }, [activeFolder]);

  const sortedWorkflows = useMemo(
    () => [...workflows].sort((a, b) => b.createdAt - a.createdAt),
    [workflows],
  );

  return { workflows, sortedWorkflows };
}
