import { useEffect, useMemo, useState } from 'react';
import { fetchWorkflows, subscribeWorkflows, type Workflow } from '../../../api';
import { sameProjectPath } from '../../../terminal/terminalScope';

// Hydrates the saved workflow list for a project and keeps it in sync via
// the `/ws/workflows` subscription.
export function useWorkflowList(activeFolder: string) {
  const [loaded, setLoaded] = useState<{ projectPath: string; workflows: Workflow[] }>(
    { projectPath: '', workflows: [] },
  );

  useEffect(() => {
    const projectPath = activeFolder;
    // Clear the previous project's list as soon as the project changes. The
    // render below also suppresses mismatched state synchronously, but this
    // keeps the stored snapshot honest while the new fetch/WS hello is pending.
    setLoaded({ projectPath, workflows: [] });
    if (!projectPath) return;

    let cancelled = false;
    const keepProjectWorkflows = (ws: Workflow[]) =>
      ws.filter((w) => sameProjectPath(w.projectPath, projectPath));
    fetchWorkflows(projectPath)
      .then((ws) => {
        if (!cancelled) {
          setLoaded({ projectPath, workflows: keepProjectWorkflows(ws) });
        }
      })
      .catch((err) => console.error('fetchWorkflows', err));
    const unsub = subscribeWorkflows(projectPath, (ws) => {
      if (!cancelled) {
        setLoaded({ projectPath, workflows: keepProjectWorkflows(ws) });
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [activeFolder]);

  // Workflows are project-scoped. During the render where activeFolder has
  // changed but the effect above has not yet cleared/refetched, hide the stale
  // array so editor/run/queue callers cannot act on the previous project.
  const workflows = loaded.projectPath === activeFolder ? loaded.workflows : [];

  const sortedWorkflows = useMemo(
    () => [...workflows].sort((a, b) => b.createdAt - a.createdAt),
    [workflows],
  );

  return { workflows, sortedWorkflows };
}
