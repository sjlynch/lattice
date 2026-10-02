import { useEffect, useState } from 'react';
import { fetchOpengrepStatus, subscribeOpengrepStatus, type OpengrepStatus } from '../../../api/opengrep';
import { sameProjectPath } from '../../../terminal/terminalScope';

// Only engine status is read automatically. A Security scan remains a click.
export function useOpengrepAvailability(project: string) {
  const [available, setAvailable] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    requestedProject: string;
    status: OpengrepStatus['project'];
  } | null>(null);
  useEffect(() => {
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let projectRevision = 0;
    setSnapshot(null);
    const acceptProject = (status: OpengrepStatus) => {
      if (!status.project) return;
      projectRevision++;
      setSnapshot({ requestedProject: project, status: status.project });
    };
    const clearPoll = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const refresh = () => {
      clearPoll();
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const revision = projectRevision;
      // Failed reads retain the last confirmed availability; initially hidden.
      void fetchOpengrepStatus(project || undefined, request.signal).then((status) => {
        // Our own response is project-pinned even if the backend resolved a
        // symlink alias. A newer shared project snapshot takes precedence.
        if (!request.signal.aborted && revision === projectRevision) acceptProject(status);
      }).catch(() => {});
    };
    const accept = (status: OpengrepStatus) => {
      setAvailable(status.available);
      if (sameProjectPath(status.project?.path, project)) acceptProject(status);
      clearPoll();
      // Continue observing an accepted install even if Settings is closed.
      if (status.installJob?.status === 'running') timer = setTimeout(refresh, 1500);
    };
    const unsubscribe = subscribeOpengrepStatus(accept);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    refresh();
    return () => {
      unsubscribe();
      clearPoll();
      controller?.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [project]);
  return { available, projectStatus: snapshot?.requestedProject === project ? snapshot.status : undefined };
}
