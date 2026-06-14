import { useCallback, useEffect, useState } from 'react';
import {
  checkGit,
  fetchPushRunStatus,
  forgetPushRun as apiForgetPushRun,
  startPushRun,
} from '../../../api';
import type { TerminalSpec } from '../../../TerminalsContext';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;
type CloseTerminal = (id: string) => void;

// Owns the QA-lane Push button: probes for `.git`, kicks off a push run,
// polls its status, and tears down the local terminal once the backend's
// Stop hook flips the run to `done`.
export function usePushRun(
  activeFolder: string,
  addTerminal: AddTerminal,
  closeTerminal: CloseTerminal,
  showError: (msg: string) => void,
) {
  // Active push run, if any. Tracking both ids lets us close the terminal
  // (local) and forget the run on the backend (server) when the Stop hook
  // marks it done. Null when no push is in flight; the QA-lane button is
  // rendered only when activeFolder has a `.git` and disabled while non-null.
  const [activePush, setActivePush] = useState<
    { runId: string; terminalId: string } | null
  >(null);
  const [hasGit, setHasGit] = useState(false);

  // Probe for `.git` so the QA-lane Push button is hidden in non-git
  // projects (where the action is meaningless). Re-runs on folder switch.
  useEffect(() => {
    if (!activeFolder) {
      setHasGit(false);
      return;
    }
    let cancelled = false;
    checkGit(activeFolder)
      .then((r) => { if (!cancelled) setHasGit(r.hasGit); })
      .catch(() => { if (!cancelled) setHasGit(false); });
    return () => { cancelled = true; };
  }, [activeFolder]);

  // Poll the active push run; when the backend's Stop hook flips it to
  // `done`, close the local terminal and forget the run. 2 s feels live
  // without hammering the backend (the Claude session is busy doing git
  // operations, not running an inner loop).
  useEffect(() => {
    if (!activePush) return;
    let cancelled = false;
    let handle: number | null = null;
    const tick = async () => {
      const status = await fetchPushRunStatus(activePush.runId).catch(() => null);
      if (cancelled) return;
      // status === null means the run has been forgotten on the server. The
      // only way that happens is if the user manually closed the terminal,
      // which already triggered a DELETE; either way, we're done tracking it.
      if (!status || status.status === 'done') {
        closeTerminal(activePush.terminalId);
        apiForgetPushRun(activePush.runId).catch(() => {});
        setActivePush(null);
      }
    };
    const startPolling = () => {
      if (handle === null) handle = window.setInterval(() => { void tick(); }, 2000);
    };
    const stopPolling = () => {
      if (handle !== null) {
        window.clearInterval(handle);
        handle = null;
      }
    };
    // Pause polling while the tab is backgrounded — the run keeps progressing
    // on the backend, so there's no point hammering it from a hidden tab.
    // Resume (with an immediate check) when the tab is foregrounded again.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        void tick();
        startPolling();
      }
    };
    if (document.visibilityState !== 'hidden') startPolling();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [activePush, closeTerminal]);

  const startPush = useCallback(async () => {
    if (!activeFolder || activePush) return;
    try {
      const res = await startPushRun(activeFolder);
      const terminalId = addTerminal({
        label: 'push',
        cwd: res.cwd,
        initialCommand: res.command,
        projectPath: activeFolder,
        serverId: res.serverId,
      });
      setActivePush({ runId: res.id, terminalId });
    } catch (err) {
      showError(`Push failed to start: ${(err as Error).message}`);
    }
  }, [activeFolder, activePush, addTerminal, showError]);

  return { activePush, startPush, hasGit };
}
