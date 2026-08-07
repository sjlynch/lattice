import assert from 'node:assert/strict';
import test from 'node:test';

import { agentHarnessForCommand } from '../harnesses.js';
import {
  TERMINAL_BUSY_IDLE_MS,
  computeBusyTerminalIds,
} from '../terminalActivity.js';

// The two pure halves of the sidebar tab spinner's signal. Everything else in
// terminalActivity.ts is the poll loop / fan-out; these decide what the user
// actually sees, so they're the parts worth pinning.

const NOW = 1_700_000_000_000;

function session(over: Record<string, unknown>): Record<string, unknown> {
  return { id: 's1', lastOutputAt: NOW, initialCommand: 'claude', ...over };
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

test('computeBusyTerminalIds reports only recently-active agent sessions', () => {
  const busy = computeBusyTerminalIds(
    [
      session({ id: 'agent-live', lastOutputAt: NOW - 200 }),
      session({ id: 'agent-idle', lastOutputAt: NOW - TERMINAL_BUSY_IDLE_MS }),
      session({ id: 'shell', initialCommand: undefined }),
      session({ id: 'startup', initialCommand: 'npm run dev' }),
    ],
    NOW,
  );
  assert.deepEqual(busy, ['agent-live']);
});

test('computeBusyTerminalIds treats the idle threshold as exclusive at the boundary', () => {
  const ids = (age: number) =>
    computeBusyTerminalIds([session({ lastOutputAt: NOW - age })], NOW);
  assert.deepEqual(ids(TERMINAL_BUSY_IDLE_MS - 1), ['s1']);
  assert.deepEqual(ids(TERMINAL_BUSY_IDLE_MS), []);
});

test('computeBusyTerminalIds returns a sorted set so callers can diff it as a string', () => {
  // The poll loop compares successive results by `busy.join(',')` to decide
  // whether to wake subscribers — an unstable order would broadcast (and
  // re-render every sidebar tab) on every tick.
  const busy = computeBusyTerminalIds(
    [session({ id: 'c' }), session({ id: 'a' }), session({ id: 'b' })],
    NOW,
  );
  assert.deepEqual(busy, ['a', 'b', 'c']);
});

test('computeBusyTerminalIds skips malformed session entries', () => {
  // The list crosses a process boundary as untyped JSON, so a partial/legacy
  // shape must be ignored rather than throw and stall the poll loop.
  const busy = computeBusyTerminalIds(
    [
      null,
      undefined,
      'nonsense',
      {},
      session({ id: '' }),
      session({ id: 42 }),
      // A session from a terminal-server that predates lastOutputAt.
      session({ id: 'legacy', lastOutputAt: undefined }),
      session({ id: 'ok' }),
    ],
    NOW,
  );
  assert.deepEqual(busy, ['ok']);
});
