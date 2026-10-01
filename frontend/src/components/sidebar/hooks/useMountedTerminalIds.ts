import { useEffect, useState } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

export function useMountedTerminalIds(
  activeId: string | null,
  startupTerminalsList: TerminalSpec[],
  projectTerminals: TerminalSpec[],
  terminals: TerminalSpec[],
): ReadonlySet<string> {
  // Remember activation for tabs that still exist globally. We only mount
  // <TerminalPane> once a terminal is first viewed — the backend pre-spawns
  // the pty (so initialCommand runs immediately) and keeps it alive via
  // serverId, so the session is intact when we first attach. Each mounted
  // pane allocates its own WebGL context (xterm WebglAddon); deferring mount
  // until activation is what keeps Run-All from blowing past Chrome's
  // per-page WebGL context cap.
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    if (activeId && terminals.some((t) => t.id === activeId)) initial.add(activeId);
    return initial;
  });

  useEffect(() => {
    const existingIds = new Set(terminals.map((t) => t.id));
    setMountedIds((prev) => {
      let next: Set<string> | undefined;
      // Only the global list confirms removal. Project/panel switches and
      // pending or failed closes must keep surviving tabs' activation history.
      for (const id of prev) {
        if (!existingIds.has(id)) {
          next ??= new Set(prev);
          next.delete(id);
        }
      }
      const add = (id: string) => {
        // activeId can still point at a tab removed by a registry event.
        if (!existingIds.has(id) || (next ?? prev).has(id)) return;
        next ??= new Set(prev);
        next.add(id);
      };
      if (activeId) add(activeId);

      // Force-mount startup terminals as soon as they're added, even if they're
      // not the active tab. The whole point of "Startup Terminals" is that the
      // configured commands run on page load — without this, the pty would only
      // boot the first time the user clicked into the tab. The WebGL context is
      // still only allocated while a pane is the active tab (TerminalPane gates
      // that internally), so this doesn't burn through Chrome's context cap.
      for (const t of startupTerminalsList) {
        add(t.id);
      }

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
      //
      // A tab in a restore state (`restore: 'pending' | 'failed'`) also has no
      // serverId but must NOT be force-mounted: the registry is relaunching (or
      // failed to relaunch) its pty, and a serverless attach would run the launch
      // command a second time. The Sidebar gates the pane on `!t.restore` too.
      for (const t of projectTerminals) {
        if (!t.serverId && !t.restore) add(t.id);
      }
      return next ?? prev;
    });
  }, [activeId, startupTerminalsList, projectTerminals, terminals]);

  return mountedIds;
}
