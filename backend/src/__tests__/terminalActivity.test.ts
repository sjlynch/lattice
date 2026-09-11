import assert from 'node:assert/strict';
import test from 'node:test';

import { agentHarnessForCommand } from '../harnesses.js';
import {
  EMPTY_TERMINAL_ACTIVITY,
  TERMINAL_BUSY_IDLE_MS,
  TERMINAL_BUSY_MIN_RUN_MS,
  stepTerminalActivity,
  type SessionActivity,
  type TerminalActivityState,
} from '../terminalActivity.js';

// The two pure halves of the sidebar tab spinner's signal. Everything else in
// terminalActivity.ts is the poll loop / fan-out; these decide what the user
// actually sees, so they're the parts worth pinning.

const NOW = 1_700_000_000_000;
const TICK = 1_000; // the real poll cadence

function session(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 's1', lastOutputAt: NOW, initialCommand: 'claude', ...over };
}

// Previous-poll state for a session that is mid-turn: it has been talking for
// a while, and `sampledAt` (the stamp the last poll saw) is recent enough that
// the next sample continues the same run rather than starting a new one.
function midRun(sampledAt: number): SessionActivity {
  return { lastOutputAt: sampledAt, runStartedAt: sampledAt - 5_000 };
}

// Drive a sequence of polls, one per entry: each is the `lastOutputAt` the
// terminal-server would report for `s1` at that tick (or `null` for "this
// session is gone"). Ticks are one poll interval apart, starting at `NOW`.
// `inputAt` (when given) is the matching per-tick "browser last sent this pty
// something" stamp the relay would have recorded. Returns the busy list per
// tick.
function pollSequence(
  lastOutputAts: readonly (number | null)[],
  options: {
    idleMs?: number;
    minRunMs?: number;
    inputAt?: readonly (number | null)[];
  } = {},
): string[][] {
  const { inputAt: inputAts, ...thresholds } = options;
  let state: TerminalActivityState = EMPTY_TERMINAL_ACTIVITY;
  return lastOutputAts.map((lastOutputAt, i) => {
    const sessions = lastOutputAt === null ? [] : [session({ lastOutputAt })];
    const stamp = inputAts?.[i];
    const stepped = stepTerminalActivity(sessions, state, NOW + i * TICK, {
      ...thresholds,
      ...(stamp === null || stamp === undefined
        ? {}
        : { inputAt: new Map([['s1', stamp]]) }),
    });
    state = stepped.state;
    return stepped.busy;
  });
}

test('agentHarnessForCommand recognises every Lattice-built agent command', () => {
  assert.equal(agentHarnessForCommand('claude'), 'claude');
  assert.equal(
    agentHarnessForCommand('claude --dangerously-skip-permissions'),
    'claude',
  );
  assert.equal(agentHarnessForCommand('pi --approve'), 'pi');
  assert.equal(
    agentHarnessForCommand('pi --approve --model "qwen-local/qwen"'),
    'pi',
  );
  assert.equal(agentHarnessForCommand('codex --yolo'), 'codex');
  // The per-harness rewriters splice flags in AFTER the binary, so a rewritten
  // command must still classify.
  assert.equal(
    agentHarnessForCommand('codex --config projects."C:\\x".trust_level=\'trusted\' --yolo'),
    'codex',
  );
});

test('new printable-output facts take precedence over legacy raw traffic', () => {
  const state = new Map([['s1', midRun(NOW - TICK)]]);
  for (const lastTextOutputAt of [0, NOW - 5_000, NaN, Infinity, null, 'bad', NOW + 1]) {
    const result = stepTerminalActivity([session({ lastTextOutputAt })], state, NOW);
    assert.deepEqual(result.busy, []);
  }
  assert.deepEqual(stepTerminalActivity([session({ lastTextOutputAt: NOW })], state, NOW).busy, ['s1']);
  assert.deepEqual(stepTerminalActivity([session({})], state, NOW).busy, ['s1'], 'legacy executors retain compatibility');
});

test('nonfinite and future raw timestamps cannot pin a legacy spinner on', () => {
  for (const lastOutputAt of [NaN, Infinity, -Infinity, NOW + 10_000]) {
    assert.deepEqual(stepTerminalActivity([session({ lastOutputAt })], EMPTY_TERMINAL_ACTIVITY, NOW).busy, []);
  }
});

test('agentHarnessForCommand tolerates paths, quotes, and Windows shims', () => {
  assert.equal(agentHarnessForCommand('"C:\\Program Files\\bin\\claude.cmd" --x'), 'claude');
  assert.equal(agentHarnessForCommand('/usr/local/bin/codex'), 'codex');
  assert.equal(agentHarnessForCommand('  CLAUDE  '), 'claude');
});

test('agentHarnessForCommand rejects anything that is not a harness', () => {
  // A plain shell has no initial command at all; a startup terminal has one
  // that streams output forever. Both must stay out of the busy set or the
  // spinner would be pinned on for the life of the tab.
  assert.equal(agentHarnessForCommand(undefined), null);
  assert.equal(agentHarnessForCommand(''), null);
  assert.equal(agentHarnessForCommand('   '), null);
  assert.equal(agentHarnessForCommand('npm run dev'), null);
  assert.equal(agentHarnessForCommand('git status'), null);
  // Substring matches must not count.
  assert.equal(agentHarnessForCommand('claudette --x'), null);
  assert.equal(agentHarnessForCommand('echo claude'), null);
});

// ---------------------------------------------------------------------------
// The headline regression: the sidebar must not read its OWN side effects as
// agent work.
// ---------------------------------------------------------------------------

test('a one-shot redraw on an idle agent never lights the spinner', () => {
  // Opening (or switching to) a sidebar tab blurs the pane you were on; xterm
  // reports that to the pty as a focus escape and the parked harness answers
  // with a single redraw. That used to read as "working" for the whole idle
  // window, so every existing tab span up for ~2s whenever a new tab opened.
  // A redraw is one burst: it must never reach the busy set, at any tick.
  const idleForMinutes = NOW - 300_000;
  const redrawAt = NOW + TICK; // the burst lands between tick 0 and tick 1
  const busyPerTick = pollSequence([
    idleForMinutes,
    redrawAt, // tick 1: brand-new output, but the run is 0ms long
    redrawAt, // tick 2: still the freshest stamp, still one burst
    redrawAt, // tick 3: now stale as well
  ]);
  assert.deepEqual(busyPerTick, [[], [], [], []]);

  // …and the run floor is what does it: drop it and the same redraw lights the
  // spinner for the whole idle window, which is exactly the bug.
  assert.deepEqual(
    pollSequence([idleForMinutes, redrawAt, redrawAt, redrawAt], { minRunMs: 0 }),
    [[], ['s1'], ['s1'], []],
  );
});

test('a redraw is ignored even when its burst straddles two polls', () => {
  // The burst is a few ms wide but can land either side of a tick boundary.
  // The run is measured from the pty's own stamps, not from poll timing, so a
  // 40ms redraw stays a 40ms redraw however it happens to be sampled.
  const busyPerTick = pollSequence([
    NOW - 300_000,
    NOW + TICK - 5, // first bytes of the redraw
    NOW + TICK + 35, // the rest, sampled on the next tick
    NOW + TICK + 35,
  ]);
  assert.deepEqual(busyPerTick, [[], [], [], []]);
});

test('scrolling a parked agent never lights the spinner, however long you scroll', () => {
  // Scrolling forwards a wheel escape per notch and the harness repaints for as
  // long as you keep going — sustained output, so the run floor alone can't tell
  // it from work. What gives it away is that the user is DRIVING it: the input
  // stamp advances alongside the output it provokes, so the run never gets a
  // second clear of the last thing the browser sent.
  const scrollFrom = NOW + TICK;
  // Five seconds of scrolling: each tick, the last wheel escape and the redraw
  // it caused are ~40ms apart, right up to the moment of the poll.
  const busyPerTick = pollSequence(
    [
      NOW - 300_000, // parked at its prompt
      scrollFrom + 40,
      scrollFrom + TICK + 40,
      scrollFrom + 2 * TICK + 40,
      scrollFrom + 3 * TICK + 40,
      scrollFrom + 4 * TICK + 40, // scrolling stops here
      scrollFrom + 4 * TICK + 40,
      scrollFrom + 4 * TICK + 40,
    ],
    {
      inputAt: [
        null,
        scrollFrom,
        scrollFrom + TICK,
        scrollFrom + 2 * TICK,
        scrollFrom + 3 * TICK,
        scrollFrom + 4 * TICK,
        scrollFrom + 4 * TICK, // stamp stops advancing with the gesture
        scrollFrom + 4 * TICK,
      ],
    },
  );
  assert.deepEqual(busyPerTick, [[], [], [], [], [], [], [], []]);
});

test('work the user kicked off still counts — the input ends, the output does not', () => {
  // The mirror of the scroll case, and the one that must not regress: you type
  // a prompt and hit Enter, so there IS recent input, and then the agent works.
  // Its output runs away from that last keystroke, which is exactly the shape
  // the gate keys on.
  const enter = NOW;
  const busyPerTick = pollSequence(
    [
      enter, // tick 0: the Enter echo
      enter + TICK, // tick 1: a second of the agent's own output → busy
      enter + 2 * TICK,
      enter + 3 * TICK,
    ],
    { inputAt: [enter, enter, enter, enter] },
  );
  assert.deepEqual(busyPerTick, [[], ['s1'], ['s1'], ['s1']]);
});

test('a redraw landing inside a just-finished run does not extend the spinner', () => {
  // Where the input gate earns its keep over the run floor alone. Switch away
  // from a tab whose agent has only just stopped and the blur redraw arrives
  // while its run is still open (no idle-width gap to end it), so the floor is
  // long since satisfied and the redraw simply prolongs the spinner. The gate
  // sees the frame the browser sent and refuses to count from before it.
  const outputs = [
    NOW, // run starts
    NOW + TICK, // working
    NOW + 2 * TICK, // last real output — the turn ends here
    NOW + 2 * TICK, // quiet
    NOW + 3.5 * TICK, // the blur redraw, 1.5s later: same run, no gap
    NOW + 3.5 * TICK,
  ];
  const blurAt = NOW + 3.5 * TICK;

  assert.deepEqual(
    pollSequence(outputs, {
      inputAt: [null, null, null, null, blurAt, blurAt],
    }),
    // Busy through the turn and its idle grace, then quiet — the redraw adds
    // nothing.
    [[], ['s1'], ['s1'], ['s1'], [], []],
  );

  // Without the stamp (an unattached pane can't produce one) the floor alone
  // lets that redraw ride in on the finished turn's run — which is what the
  // gate is here to stop.
  assert.deepEqual(pollSequence(outputs), [
    [],
    ['s1'],
    ['s1'],
    ['s1'],
    ['s1'],
    ['s1'],
  ]);
});

test('a freshly spawned session is not busy on the strength of its seeded stamp', () => {
  // createSession seeds `lastOutputAt` at spawn so a silent pty still has a
  // usable clock. That seed must not read as a second of output — a new tab
  // would otherwise spin before its harness had written a byte.
  const spawnedAt = NOW;
  assert.deepEqual(pollSequence([spawnedAt, spawnedAt, spawnedAt]), [[], [], []]);
});

test('a harness emitting continuously is reported busy, and clears when it stops', () => {
  // A working harness animates its status line for the whole turn, so its
  // stamp advances every tick — that is the shape the spinner exists for.
  const busyPerTick = pollSequence([
    NOW, // tick 0: run starts here, nothing behind it yet
    NOW + TICK, // tick 1: a second of unbroken output → busy
    NOW + 2 * TICK,
    NOW + 3 * TICK, // tick 3: last output, the turn ends here
    NOW + 3 * TICK, // tick 4: quiet, but still inside the idle window
    NOW + 3 * TICK, // tick 5: idle
  ]);
  assert.deepEqual(busyPerTick, [[], ['s1'], ['s1'], ['s1'], ['s1'], []]);
});

test('a redraw after a finished turn does not inherit that turn\'s run', () => {
  // The gap between turns is what ends a run. Without that reset, an agent
  // that worked for a minute would leave a run long enough for any later
  // focus redraw to ride in on.
  const busyPerTick = pollSequence([
    NOW,
    NOW + TICK, // working
    NOW + 2 * TICK, // working
    NOW + 2 * TICK, // quiet
    NOW + 2 * TICK, // quiet — run is over
    NOW + 5 * TICK, // a lone redraw, well past the idle window
    NOW + 5 * TICK,
  ]);
  assert.deepEqual(busyPerTick, [[], ['s1'], ['s1'], ['s1'], [], [], []]);
});

test('a pause shorter than the idle window keeps the run going', () => {
  // The idle window is also what holds the spinner steady through the small
  // gaps in a harness's own repaint loop — a brief quiet spell must not
  // restart the run and drop the spinner mid-turn.
  const busyPerTick = pollSequence([
    NOW,
    NOW + TICK, // busy
    NOW + TICK, // one quiet tick (still inside the idle window)
    NOW + 2 * TICK + 500, // talking again — same run, so still busy
  ]);
  assert.deepEqual(busyPerTick, [[], ['s1'], ['s1'], ['s1']]);
});

test('the idle threshold is exclusive at the boundary', () => {
  const state = new Map([['s1', midRun(NOW - 2_500)]]);
  const at = (age: number) =>
    stepTerminalActivity([session({ lastOutputAt: NOW - age })], state, NOW).busy;
  // Run length is satisfied either way (a long carried run); only recency moves.
  assert.deepEqual(at(TERMINAL_BUSY_IDLE_MS - 1), ['s1']);
  assert.deepEqual(at(TERMINAL_BUSY_IDLE_MS), []);
});

test('the minimum-run threshold is inclusive at the boundary', () => {
  const runStartedAt = NOW - TERMINAL_BUSY_MIN_RUN_MS;
  const at = (runLength: number) =>
    stepTerminalActivity(
      [session({ lastOutputAt: runStartedAt + runLength })],
      new Map([['s1', { lastOutputAt: runStartedAt, runStartedAt }]]),
      NOW,
    ).busy;
  assert.deepEqual(at(TERMINAL_BUSY_MIN_RUN_MS - 1), []);
  assert.deepEqual(at(TERMINAL_BUSY_MIN_RUN_MS), ['s1']);
});

test('only agent sessions are considered, however chatty they are', () => {
  // A plain shell and a `npm run dev` terminal stream output for their whole
  // life — exactly the shape that satisfies the sustained-output test — so the
  // harness check has to come first or the spinner would be pinned on forever.
  const run = (id: string, initialCommand?: string) => {
    // Two polls a tick apart, output right up to each — an unbroken stream.
    const first = stepTerminalActivity(
      [session({ id, initialCommand, lastOutputAt: NOW - TICK })],
      EMPTY_TERMINAL_ACTIVITY,
      NOW - TICK,
    );
    return stepTerminalActivity(
      [session({ id, initialCommand, lastOutputAt: NOW })],
      first.state,
      NOW,
    ).busy;
  };
  assert.deepEqual(run('agent', 'claude'), ['agent']);
  assert.deepEqual(run('shell', undefined), []);
  assert.deepEqual(run('startup', 'npm run dev'), []);
});

test('busy ids come back sorted so the poll loop can diff them as a string', () => {
  // The poll loop compares successive results by `busy.join(',')` to decide
  // whether to wake subscribers — an unstable order would broadcast (and
  // re-render every sidebar tab) on every tick.
  const ids = ['c', 'a', 'b'];
  const previous = new Map(ids.map((id) => [id, midRun(NOW - TICK)]));
  const { busy } = stepTerminalActivity(
    ids.map((id) => session({ id, lastOutputAt: NOW - 100 })),
    previous,
    NOW,
  );
  assert.deepEqual(busy, ['a', 'b', 'c']);
});

test('malformed session entries are skipped', () => {
  // The list crosses a process boundary as untyped JSON, so a partial/legacy
  // shape must be ignored rather than throw and stall the poll loop.
  const previous = new Map([['ok', midRun(NOW - TICK)]]);
  const { busy } = stepTerminalActivity(
    [
      null,
      undefined,
      'nonsense',
      {},
      session({ id: '' }),
      session({ id: 42 }),
      // A session from a terminal-server that predates lastOutputAt.
      session({ id: 'legacy', lastOutputAt: undefined }),
      session({ id: 'ok', lastOutputAt: NOW - 100 }),
    ],
    previous,
    NOW,
  );
  assert.deepEqual(busy, ['ok']);
});

test('the carried state is rebuilt from each snapshot, so closed ptys drop out', () => {
  // The state map is per-session bookkeeping; if it only ever grew, a long-
  // running backend would carry an entry for every terminal ever opened.
  const first = stepTerminalActivity(
    [session({ id: 'a' }), session({ id: 'b' })],
    EMPTY_TERMINAL_ACTIVITY,
    NOW,
  );
  assert.deepEqual([...first.state.keys()].sort(), ['a', 'b']);
  const second = stepTerminalActivity([session({ id: 'a' })], first.state, NOW + TICK);
  assert.deepEqual([...second.state.keys()], ['a']);
});
