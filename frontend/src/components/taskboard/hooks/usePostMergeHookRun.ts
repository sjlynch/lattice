import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abortPostMergeHook,
  getActivePostMergeHook,
  subscribePostMergeHooks,
  type PostMergeHookRun,
} from '../../../api';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';

type AddTerminal = (spec: AddTerminalSpec, focus?: boolean) => string;

// Active/recent runs for the PostMergeHookRow, including terminal tabs and abort.
export function usePostMergeHookRun(
  activeFolder: string,
  addTerminal: AddTerminal,
  showError: (msg: string) => void,
) {
  const [active, setActive] = useState<PostMergeHookRun | null>(null);
  const [recent, setRecent] = useState<PostMergeHookRun | null>(null);
  // Track which hook ids we've already spawned a terminal tab for, so the
  // WS firing multiple progress events (or a reconnect re-sending 'started')
  // doesn't open a new terminal each time. A ref instead of state because the
  // set is consulted inside the WS callback (we don't render off it) — keeping
  // it out of the render cycle avoids a stale-closure footgun.
  const spawnedTerminalsRef = useRef<Set<string>>(new Set());

  // Hydrate + subscribe to live updates.
  useEffect(() => {
    setActive(null);
    setRecent(null);
    spawnedTerminalsRef.current = new Set();
    if (!activeFolder) return;
    let cancelled = false;
    let receivedLiveState = false;

    getActivePostMergeHook(activeFolder)
      .then((snap) => {
        if (cancelled || receivedLiveState) return;
        setActive(snap.active);
        setRecent(snap.recent);
      })
      .catch(() => {
        /* ignore — WS will populate */
      });

    const unsub = subscribePostMergeHooks(activeFolder, (ev) => {
      if (cancelled) return;
      receivedLiveState = true;
      if (ev.type === 'idle') {
        setActive(null);
        return;
      }
      if (ev.type === 'started' || ev.type === 'progress') {
        if (ev.run.status === 'running') {
          setActive(ev.run);
          // Spawn a terminal tab the first time we see this run with a
          // serverId. The backend pre-creates the pty so the WS pane just
          // attaches to it; only one tab per hook even if WS reconnects
          // resend the 'started' event.
          if (ev.run.serverId && !spawnedTerminalsRef.current.has(ev.run.id)) {
            spawnedTerminalsRef.current.add(ev.run.id);
            // focus=true so the terminal tab actually pops into view — the
            // hook is blocking the merge step, so the user should see what's
            // happening immediately rather than have to hunt for the tab
            // (the first cut shipped focus=false and left users wondering
            // whether the hook had even started).
            addTerminal(
              {
                id: ev.run.terminalId,
                label: `post-merge:${ev.run.id.slice(-6)}`,
                cwd: ev.run.cwd,
                projectPath: ev.run.projectPath,
                serverId: ev.run.serverId,
              },
              true,
            );
          }
        } else {
          setActive(null);
          setRecent(ev.run);
        }
      } else if (ev.type === 'finished') {
        setActive(null);
        setRecent(ev.run);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder, addTerminal]);

  const abort = useCallback(async () => {
    if (!active) return;
    try {
      await abortPostMergeHook(active.id);
    } catch (err) {
      showError(`Abort failed: ${(err as Error).message}`);
    }
  }, [active, showError]);

  return { active, recent, abort };
}
