import { useEffect, useRef, useState } from 'react';
import type { TerminalSpec } from '../../../TerminalsContext';

// Most hidden panes kept mounted. Each mounted pane holds a 20 000-line xterm
// buffer (~17 MB at 50 cols, ~65 MB maximized), a live `/ws/terminal` socket
// and up to 8M chars of queued output, so an uncapped set grew with every tab
// ever viewed. Past the cap the least recently ACTIVE eligible pane unmounts:
// only a pane whose pty lives server-side (`serverId`, not restoring) and that
// is not a startup terminal. Its pty keeps running; re-activating it remounts
// and re-attaches with the server's scrollback replay (the same path a
// project switch takes).
export const MAX_BACKGROUND_PANES = 6;

export function useMountedTerminalIds(
  activeId: string | null,
  startupTerminalsList: TerminalSpec[],
  projectTerminals: TerminalSpec[],
  terminals: TerminalSpec[],
): ReadonlySet<string> {
  // Remember activation for tabs that still exist globally. We only mount
  // <TerminalPane> once a terminal is first viewed — the backend pre-spawns
  // the pty (so initialCommand runs immediately) and keeps it alive via
  // serverId, so the session is intact when we first attach. Only the active
  // pane holds a WebGL context (`useActiveTerminalWebgl`); every mounted pane
  // still keeps an xterm buffer and a live `/ws/terminal` socket, so deferring
  // mount until activation keeps Run-All from opening a socket, buffer and
  // scrollback replay per task the user never looks at.
  // Activation order (id → sequence) for least-recently-active eviction.
  const lastActiveRef = useRef(new Map<string, number>());
  const activationSeqRef = useRef(0);
  const [mountedIds, setMountedIds] = useState<ReadonlySet<string>>(() => {
    const initial = new Set<string>();
    if (activeId && terminals.some((t) => t.id === activeId)) initial.add(activeId);
    return initial;
  });

  useEffect(() => {
    const existingIds = new Set(terminals.map((t) => t.id));
    const lastActive = lastActiveRef.current;
    if (activeId && existingIds.has(activeId)) lastActive.set(activeId, ++activationSeqRef.current);
    for (const id of lastActive.keys()) if (!existingIds.has(id)) lastActive.delete(id);
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

      const specs = new Map(terminals.map((t) => [t.id, t]));
      const startupIds = new Set(startupTerminalsList.map((t) => t.id));
      const evictable = [...(next ?? prev)].filter((id) => {
        const spec = specs.get(id);
        return id !== activeId && !startupIds.has(id) && !!spec?.serverId && !spec.restore;
      });
      if (evictable.length > MAX_BACKGROUND_PANES) {
        evictable.sort((a, b) => (lastActive.get(a) ?? 0) - (lastActive.get(b) ?? 0));
        next ??= new Set(prev);
        for (const id of evictable.slice(0, evictable.length - MAX_BACKGROUND_PANES)) next.delete(id);
      }
      return next ?? prev;
    });
  }, [activeId, startupTerminalsList, projectTerminals, terminals]);

  return mountedIds;
}
