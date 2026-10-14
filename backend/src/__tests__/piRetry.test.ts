// The generated lattice-retry.ts: continues an unattended Pi session after a
// transient server error Pi's own retry misses, with backoff and a cap; never
// after a real error or a clean turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PI_CONTINUE_ERROR_PATTERN,
  PI_CONTINUE_MAX,
  PI_CONTINUE_PROMPT,
  piContinueDelayMs,
  renderPiRetryExtension,
} from '../piRetry.js';

type Handler = (event?: unknown) => void;

async function loadExtension() {
  const url = `data:text/javascript;base64,${Buffer.from(renderPiRetryExtension()).toString('base64')}`;
  const mod = (await import(url)) as { default: (pi: unknown) => void };
  const handlers = new Map<string, Handler>();
  const sent: string[] = [];
  mod.default({
    on: (name: string, fn: Handler) => handlers.set(name, fn),
    sendUserMessage: (text: string) => sent.push(text),
  });
  const turn = (errorMessage?: string) => {
    handlers.get('agent_end')!({
      messages: [{ role: 'assistant', stopReason: errorMessage ? 'error' : 'stop', errorMessage }],
    });
    handlers.get('agent_settled')!();
  };
  return { turn, sent, handlers };
}

const ADMISSION = 'inference request expired while waiting for admission';

test('the pattern covers the local endpoint failures, not ordinary request errors', () => {
  assert.ok(PI_CONTINUE_ERROR_PATTERN.test(ADMISSION));
  assert.ok(PI_CONTINUE_ERROR_PATTERN.test('Model is still loading, try again'));
  assert.ok(!PI_CONTINUE_ERROR_PATTERN.test('400 invalid tool schema'));
  assert.ok(!PI_CONTINUE_ERROR_PATTERN.test('context length exceeded'));
});

test('continues after a transient error with exponential backoff, capped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { turn, sent } = await loadExtension();
  for (let attempt = 1; attempt <= PI_CONTINUE_MAX; attempt += 1) {
    turn(ADMISSION);
    t.mock.timers.tick(piContinueDelayMs(attempt) - 1);
    assert.equal(sent.length, attempt - 1, `not before the attempt-${attempt} delay`);
    t.mock.timers.tick(1);
    assert.equal(sent.length, attempt);
  }
  turn(ADMISSION);
  t.mock.timers.tick(10 * 60_000);
  assert.equal(sent.length, PI_CONTINUE_MAX, 'gives up after the cap');
  assert.equal(sent[0], PI_CONTINUE_PROMPT);
});

test('a clean turn resets the streak; a non-transient error never continues', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { turn, sent } = await loadExtension();
  turn(ADMISSION);
  t.mock.timers.tick(piContinueDelayMs(1));
  turn();
  turn(ADMISSION);
  t.mock.timers.tick(piContinueDelayMs(1));
  assert.equal(sent.length, 2, 'the streak restarted at attempt 1');
  turn('400 invalid request');
  turn();
  t.mock.timers.tick(10 * 60_000);
  assert.equal(sent.length, 2);
});

test('shutdown cancels a pending continuation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { turn, sent, handlers } = await loadExtension();
  turn(ADMISSION);
  handlers.get('session_shutdown')!();
  t.mock.timers.tick(10 * 60_000);
  assert.equal(sent.length, 0);
});
