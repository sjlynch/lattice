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
// Codex reports its explicit turn status in the terminal title. Printable
// output cannot classify it: its welcome screen animates at an empty prompt.
// Claude and Pi use the sustained printable-output heuristic below. The
// terminal-server preserves lastOutputAt for existing liveness consumers.
//
// It is SUSTAINED output, not merely recent output. A full-screen TUI also
// redraws for reasons that have nothing to do with the agent working, and the
// sidebar itself provokes them: switching tabs blurs one xterm and focuses
// another, which xterm reports to the pty as a focus escape (`ESC [ O` /
// `ESC [ I`), and every harness answers with a redraw. Recency alone therefore
// lit the spinner on the tab you just LEFT every time you opened a new one —
// for the whole idle window, on an agent that had been parked at its prompt for
// minutes. A redraw is one short burst; working is a continuous stream. See
// TERMINAL_BUSY_MIN_RUN_MS.
//
// Only harness sessions are reported: a plain shell or a `npm run dev` startup
// terminal streams output for as long as it lives and would pin the spinner on
// forever.

import { agentHarnessForCommand } from './harnesses.js';
import { proxyListSessionsShared } from './terminalServerClient.js';
import { createTerminalActivityPoller } from './terminalActivityPoller.js';
import { codexTitleIsWorking } from './codexTerminalActivity.js';
import { getObservedTerminalTitle } from './terminalActivityRelay.js';

// How long a session may go without printable output before it counts as idle.
// Comfortably longer than any within-frame gap in a harness's spinner animation
// (so a working agent never flickers off) while still noticing a finished agent
// within a few seconds. Policy — see the fingerprint note in
// `terminal/sessionTypes.ts` for why it lives on this side.
export const TERMINAL_BUSY_IDLE_MS = 2_000;

// How long a pty must have been emitting WITHOUT a gap before it counts as
// working. A harness mid-turn animates its status line for as long as the turn
// lasts and clears this within a tick; a one-shot redraw never does, however
// recent it is.
//
// This is the floor that keeps the sidebar's own side effects out of the
// signal. Opening a tab (or just switching to one) blurs the pane you were on,
// xterm forwards that to the pty as a focus escape, and the idle agent redraws
// — a single burst, a few ms wide. Attaching a pane resizes the pty, with the
// same result. So does a freshly spawned session, whose `lastOutputAt` is
// seeded at spawn before it has written a byte. None of those are work, and
// none of them last a second. Policy, so it lives here — see the fingerprint
// note in `terminal/sessionTypes.ts`.
export const TERMINAL_BUSY_MIN_RUN_MS = 1_000;

// How long a client-input stamp stays interesting. The gate below only ever
// compares it against the last second or so of output; keeping the map to a
// minute's worth is purely so it can't grow for the life of the process.
const CLIENT_INPUT_TTL_MS = 60_000;

// When the browser last sent something toward a pty, by session id. Fed by the
// `/ws/terminal` relay (`terminalWsRelay.ts`) — the main backend proxies that
// socket, so it sees the input side without the terminal-server having to
// report it (which would change its fingerprint and respawn every live pty).
//
// The run floor above catches a redraw that is one short burst. This catches
// the other half: a redraw the user DRIVES, which is as sustained as they care
// to make it. Scrolling a Claude pane forwards a wheel escape per notch and the
// TUI repaints for as long as you keep scrolling — output for seconds on end,
// indistinguishable from work by shape alone, but not work.
const clientInputAt = new Map<string, number>();

/**
 * Record that the browser sent a frame toward `sessionId`'s pty — input,
 * a resize, anything. Output that lands within `TERMINAL_BUSY_MIN_RUN_MS` of it
 * is treated as the pty answering the user rather than the agent working.
 *
 * Deliberately not "input" in the narrow sense: every client→pty frame is
 * something the UI or the user did, and all of them can provoke a redraw.
 */
export function noteTerminalClientInput(
  sessionId: string,
  at: number = Date.now(),
): void {
  if (!sessionId) return;
  clientInputAt.set(sessionId, at);
}

function pruneClientInput(now: number): void {
  for (const [id, at] of clientInputAt) {
    if (now - at > CLIENT_INPUT_TTL_MS) clientInputAt.delete(id);
  }
}

export type TerminalSessionSnapshot = {
  id?: unknown;
  lastOutputAt?: unknown;
  lastTextOutputAt?: unknown;
  terminalTitle?: unknown;
  initialCommand?: unknown;
};

// What one poll carries over to the next, per session: the output stamp we saw
// last time, and when the current unbroken run of output began. Deriving "how
// long has this pty been talking" needs the previous sample — the
// terminal-server only ever reports the LATEST stamp.
export type SessionActivity = {
  lastOutputAt: number;
  runStartedAt: number;
};

export type TerminalActivityState = ReadonlyMap<string, SessionActivity>;

export const EMPTY_TERMINAL_ACTIVITY: TerminalActivityState = new Map();

/**
 * Pure: fold one `/sessions` snapshot into the carried per-session state and
 * report which agent ptys are working.
 *
 * Codex uses its explicit Working title, independently of output recency.
 * Claude/Pi are busy when they emitted within `idleMs` AND have been emitting for
 * at least `minRunMs` — measured from the later of the run's start and the last
 * frame the browser sent that pty (`inputAt`), so output the user is driving
 * never accumulates a run no matter how long they drive it. The run itself is
 * measured from the pty's own timestamps rather than from poll timing, so a
 * burst that happens to straddle two ticks still reads as the burst it is.
 *
 * Returns the ids sorted, so callers can compare successive results as plain
 * strings, and the next state — rebuilt from THIS snapshot, so a killed pty's
 * entry is dropped instead of accumulating for the life of the process.
 */
export function stepTerminalActivity(
  sessions: readonly unknown[],
  previous: TerminalActivityState,
  now: number,
  options: {
    idleMs?: number;
    minRunMs?: number;
    inputAt?: ReadonlyMap<string, number>;
    titleForSession?: (id: string) => string | null | undefined;
  } = {},
): { busy: string[]; state: TerminalActivityState } {
  const idleMs = options.idleMs ?? TERMINAL_BUSY_IDLE_MS;
  const minRunMs = options.minRunMs ?? TERMINAL_BUSY_MIN_RUN_MS;
  const inputAt = options.inputAt;
  const busy: string[] = [];
  const state = new Map<string, SessionActivity>();
  for (const raw of sessions) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as TerminalSessionSnapshot;
    if (typeof s.id !== 'string' || !s.id) continue;
    const command = typeof s.initialCommand === 'string' ? s.initialCommand : undefined;
    const harness = agentHarnessForCommand(command);
    if (!harness) continue;
    if (harness === 'codex') {
      // Native facts survive backend restarts. Existing browser relays supply
      // the same fact for retained executors without the new field. Explicit
      // null/invalid native titles remain unknown and never use old telemetry.
      const title = s.terminalTitle === undefined ? options.titleForSession?.(s.id) : s.terminalTitle;
      if (codexTitleIsWorking(title)) busy.push(s.id);
      continue;
    }
    // A supported zero timestamp means no printable output yet. Only absent
    // fields on Claude/Pi fall back to raw bytes from compatible old executors.
    const stamp = s.lastTextOutputAt === undefined ? s.lastOutputAt : s.lastTextOutputAt;
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0 || stamp > now) continue;

    const lastOutputAt = stamp;
    const before = previous.get(s.id);
    // A gap wider than the idle window means the pty went quiet and started
    // talking again — that's a NEW run, so a redraw arriving after a finished
    // turn can't inherit the run length that turn built up. A session we're
    // seeing for the first time counts as a new run too: with no history, the
    // conservative read is "this one just began".
    const continues =
      before !== undefined && lastOutputAt >= before.lastOutputAt &&
      lastOutputAt - before.lastOutputAt < idleMs;
    const runStartedAt = continues ? before.runStartedAt : lastOutputAt;
    state.set(s.id, { lastOutputAt, runStartedAt });

    if (now - lastOutputAt >= idleMs) continue;
    // The run only counts from the last thing the browser sent this pty. While
    // the user keeps scrolling (or typing), that stamp keeps advancing with the
    // output it provokes, so the span stays near zero however long they go on;
    // once they stop, the redraws stop with them and it never catches up. Work
    // the user KICKED OFF is unaffected — the input ends at the Enter key and
    // the agent's own output runs away from it.
    const drivenUntil = inputAt?.get(s.id) ?? 0;
    const countFrom = Math.max(runStartedAt, drivenUntil);
    if (lastOutputAt - countFrom < minRunMs) continue;
    busy.push(s.id);
  }
  return { busy: busy.sort(), state };
}

// One shared loop with bounded stale display state and subscription fencing.
// This display-only signal never controls terminal or workflow lifecycle.
let activity: TerminalActivityState = EMPTY_TERMINAL_ACTIVITY;
const poller = createTerminalActivityPoller({
  reset: () => { activity = EMPTY_TERMINAL_ACTIVITY; },
  fetchBusy: async (isCurrent) => {
    // The shared ≤750 ms `/sessions` snapshot. The terminal-registry watch
    // deliberately does NOT share it (see terminalRegistry/watch.ts).
    const sessions = await proxyListSessionsShared();
    // Fence fold state too: a finished old probe must not revive the previous
    // subscriber generation after the last browser has disconnected.
    if (!isCurrent() || sessions === null) return null;
    const now = Date.now();
    pruneClientInput(now);
    const stepped = stepTerminalActivity(sessions, activity, now, {
      inputAt: clientInputAt, titleForSession: getObservedTerminalTitle,
    });
    activity = stepped.state;
    return stepped.busy;
  },
});

// Machine-wide ids are intersected with project-scoped tabs in the sidebar.
// Subscribe emits the current set immediately and thereafter only on changes.
export function subscribeTerminalActivity(listener: (busyIds: string[]) => void): () => void {
  return poller.subscribe(listener);
}
