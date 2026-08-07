// "Is the agent in this terminal still working?" — the signal behind the
// sidebar's per-tab spinner (`/ws/terminal-activity`).
//
// WHY IT LIVES HERE (and not in the frontend): the sidebar lazy-mounts a
// `TerminalPane` only after a tab is first activated, so an un-clicked tab has
// no WebSocket and the frontend sees none of its output. That is exactly the
// case the spinner exists for — "Run All" spawns a dozen agent tabs and you want
// to know which are still going WITHOUT opening each one. The only vantage point
// that sees every pty is the terminal-server, so the answer is derived here.
//
// WHY IT POLLS: the ptys live in the DETACHED terminal-server process, which has
// no event channel back into this one. One poll here serves every browser tab
// and every project, and it only runs while at least one client is subscribed.
//
// THE SIGNAL IS A HEURISTIC, on purpose. All three harnesses repaint a status
// line continuously while they work (an animated spinner plus an elapsed-time
// counter) and fall silent at their prompt, so output recency tracks "actively
// working" closely enough for a 12px glyph — with no per-harness hooks, and
// covering Codex and Pi, which have no activity hooks at all. Notably it reads
// "waiting for you to approve a tool" as not-working, which is the right answer.
//
// Only harness sessions are reported: a plain shell or a `npm run dev` startup
// terminal streams output for as long as it lives and would pin the spinner on
// forever.

import { agentHarnessForCommand } from './harnesses.js';
import { proxyListSessionsOrNull } from './terminalServerClient.js';

// How long a session may go without emitting a byte before it counts as idle.
// Comfortably longer than any within-frame gap in a harness's spinner animation
// (so a working agent never flickers off) while still noticing a finished agent
// within a few seconds. Policy — see the fingerprint note in
// `terminal/sessionTypes.ts` for why it lives on this side.
export const TERMINAL_BUSY_IDLE_MS = 2_000;

// Poll cadence against the terminal-server's `/sessions`. Cheap (a loopback GET
// returning a short JSON array) and only ticks while someone is watching.
const POLL_INTERVAL_MS = 1_000;

export type TerminalSessionSnapshot = {
  id?: unknown;
  lastOutputAt?: unknown;
  initialCommand?: unknown;
};

// Pure: which of these sessions are agent ptys that produced output recently.
// Sorted so callers can compare successive results as plain strings.
export function computeBusyTerminalIds(
  sessions: readonly unknown[],
  now: number,
  idleMs: number = TERMINAL_BUSY_IDLE_MS,
): string[] {
  const busy: string[] = [];
  for (const raw of sessions) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as TerminalSessionSnapshot;
    if (typeof s.id !== 'string' || !s.id) continue;
    if (typeof s.lastOutputAt !== 'number') continue;
    const command = typeof s.initialCommand === 'string' ? s.initialCommand : undefined;
    if (!agentHarnessForCommand(command)) continue;
    if (now - s.lastOutputAt >= idleMs) continue;
    busy.push(s.id);
  }
  return busy.sort();
}

type Listener = (busyIds: string[]) => void;

const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
// Last set we broadcast, as a comparison key. Listeners are only woken when the
// set actually changes — with N agents all working the poll result is identical
// tick after tick, and every frame would otherwise re-render every sidebar tab.
let lastBusyKey = '';
let lastBusy: string[] = [];
let polling = false;

async function poll(): Promise<void> {
  // Skip a tick rather than stack requests if the terminal-server is slow.
  if (polling) return;
  polling = true;
  try {
    const sessions = await proxyListSessionsOrNull();
    // `null` is "can't tell" (terminal-server unreachable/wedged), NOT "nothing
    // is running". Hold the last known set instead of blinking every spinner
    // off during a restart — the same distinction proxyCountSessions draws for
    // the spawn queue.
    if (sessions === null) return;
    const busy = computeBusyTerminalIds(sessions, Date.now());
    const key = busy.join(',');
    if (key === lastBusyKey) return;
    lastBusyKey = key;
    lastBusy = busy;
    for (const listener of [...listeners]) {
      try {
        listener(busy);
      } catch {
        /* a wedged subscriber must not stop the fan-out */
      }
    }
  } finally {
    polling = false;
  }
}

/**
 * Watch the busy set. The listener fires immediately with the last known set
 * (so a fresh WS connection is in sync without waiting a full tick), then again
 * on every change. The poll loop starts with the first subscriber and stops
 * with the last.
 *
 * The payload is NOT project-scoped: session ids are opaque, and the sidebar
 * already scopes its tab list to the active project, so intersecting on
 * `serverId` there is both simpler and immune to the `projectPath` drift a
 * legacy/serverless session can carry (it falls back to its cwd, which for a
 * task is the worktree, not the project root).
 */
export function subscribeTerminalActivity(listener: Listener): () => void {
  listeners.add(listener);
  listener(lastBusy);
  if (!timer) {
    timer = setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);
    // Don't hold the process open just to animate a spinner.
    timer.unref?.();
    void poll();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      // Drop the cached set with the last watcher: it goes stale the moment we
      // stop polling, and replaying it to the next subscriber would show a
      // spinner for an agent that finished while nobody was looking.
      lastBusyKey = '';
      lastBusy = [];
    }
  };
}
