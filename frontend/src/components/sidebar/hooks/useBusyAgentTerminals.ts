import { useEffect, useState } from 'react';
import { subscribeTerminalActivity } from '../../../api';

const EMPTY: ReadonlySet<string> = new Set<string>();

// True when both sets hold exactly the same ids. The backend only pushes on a
// real change, but a reconnect re-sends the current set — returning the SAME
// Set reference for an unchanged frame keeps the memoized `SidebarTab` rows
// from re-rendering (and matters most under "Run All", where the set is large
// and stable for minutes at a time).
function sameIds(current: ReadonlySet<string>, next: string[]): boolean {
  if (current.size !== next.length) return false;
  return next.every((id) => current.has(id));
}

/**
 * Backend session ids (`TerminalSpec.serverId`) whose harness is still working,
 * for the per-tab spinner. Empty until the first frame arrives, and while no
 * project is open or the activity feed is disconnected.
 *
 * Sourced from `/ws/terminal-activity` rather than the panes themselves because
 * a tab is only mounted after its first activation — the tabs you most want a
 * spinner on are the ones you have not opened yet.
 */
export function useBusyAgentTerminals(activeFolder: string): ReadonlySet<string> {
  const [snapshot, setSnapshot] = useState({ project: activeFolder, busy: EMPTY });

  useEffect(() => {
    setSnapshot((prev) => prev.project === activeFolder && prev.busy.size === 0
      ? prev : { project: activeFolder, busy: EMPTY });
    if (!activeFolder) return;
    let active = true;
    const unsubscribe = subscribeTerminalActivity(activeFolder, (ids) => {
      setSnapshot((prev) => {
        if (!active) return prev;
        return prev.project === activeFolder && sameIds(prev.busy, ids)
          ? prev : { project: activeFolder, busy: new Set(ids) };
      });
    });
    return () => { active = false; unsubscribe(); };
  }, [activeFolder]);

  // Project changes render before effect cleanup/reset runs. Never expose the
  // previous subscription's snapshot during that first commit.
  return snapshot.project === activeFolder ? snapshot.busy : EMPTY;
}
