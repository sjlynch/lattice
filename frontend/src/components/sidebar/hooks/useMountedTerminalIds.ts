import { useEffect, useState } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

export function useMountedTerminalIds(
  activeId: string | null,
  startupTerminalsList: TerminalSpec[],
  projectTerminals: TerminalSpec[],
): ReadonlySet<string> {
  // Track which terminal IDs have ever been the active tab. We only mount
  // <TerminalPane> once a terminal is first viewed — the backend pre-spawns
  // the pty (so initialCommand runs immediately) and keeps it alive via
  // serverId, so the session is intact when we first attach. Each mounted
  // pane allocates its own WebGL context (xterm WebglAddon); deferring mount
  // until activation is what keeps Run-All from blowing past Chrome's
  // per-page WebGL context cap.
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    if (activeId) initial.add(activeId);
    return initial;
  });

  useEffect(() => {
    setMountedIds((prev) => {
      if (!activeId || prev.has(activeId)) return prev;
      const next = new Set(prev);
      next.add(activeId);
      return next;
    });
  }, [activeId]);

  // Force-mount startup terminals as soon as they're added, even if they're
  // not the active tab. The whole point of "Startup Terminals" is that the
  // configured commands run on page load — without this, the pty would only
  // boot the first time the user clicked into the tab. The WebGL context is
  // still only allocated while a pane is the active tab (TerminalPane gates
  // that internally), so this doesn't burn through Chrome's context cap.
  useEffect(() => {
    if (startupTerminalsList.length === 0) return;
    setMountedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const t of startupTerminalsList) {
        if (!next.has(t.id)) {
          next.add(t.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [startupTerminalsList]);

  // Force-mount terminals that have no serverId yet. A spec without a
  // serverId means the backend pre-spawn didn't happen or failed — the
  // pty doesn't exist server-side, and the only thing that can create
  // it is a WS attach from a mounted <TerminalPane> (which then runs
  // the initialCommand on the freshly-created session). Without this
  // fallback, a Run-All task whose pre-spawn errored sits silent in the
  // tab list until the user clicks it. Successful pre-spawn → serverId
  // set → lazy-mount as designed; failed pre-spawn → no serverId →
  // mount immediately so the user-facing behavior degrades to a small
  // startup latency instead of a hung task.
  useEffect(() => {
    setMountedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const t of projectTerminals) {
        if (!t.serverId && !next.has(t.id)) {
          next.add(t.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [projectTerminals]);

  return mountedIds;
}
