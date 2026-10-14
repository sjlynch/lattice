// The generated lattice-retry.ts: continues an unattended Pi session after a
// transient server error Pi's own retry misses, with backoff and a cap; never
// after a real error or a clean turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PI_LENGTH_PROMPT,
  PI_MALFORMED_MAX,
  PI_MALFORMED_PROMPT,
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
  const reply = (content: unknown[]) => {
    handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'stop', content }] });
    handlers.get('agent_settled')!();
  };
  return { turn, reply, sent, handlers };
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

test('a tool call written as plain text is nudged at once, at most twice in a row', async () => {
  const { reply, sent } = await loadExtension();
  const leaked = [{ type: 'text', text: 'Let me look.\n<tool_call>\n<function=read>\n<parameter=path>x</parameter>\n</function>\n</tool_call>' }];
  for (let i = 0; i < PI_MALFORMED_MAX + 2; i += 1) reply(leaked);
  assert.deepEqual(sent, Array(PI_MALFORMED_MAX).fill(PI_MALFORMED_PROMPT));
  reply([{ type: 'text', text: 'All done.' }]);
  reply(leaked);
  assert.equal(sent.length, PI_MALFORMED_MAX + 1, 'a clean reply resets the streak');
});

test('a reply cut off at the output limit is continued, sharing the nudge cap', async () => {
  const { handlers, sent } = await loadExtension();
  const cutOff = () => {
    handlers.get('agent_end')!({ messages: [{ role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'partial…' }] }] });
    handlers.get('agent_settled')!();
  };
  for (let i = 0; i < PI_MALFORMED_MAX + 1; i += 1) cutOff();
  assert.deepEqual(sent, Array(PI_MALFORMED_MAX).fill(PI_LENGTH_PROMPT));
});

test('markup beside a real tool call, or plain prose, is left alone', async () => {
  const { reply, sent } = await loadExtension();
  reply([{ type: 'text', text: '<tool_call>' }, { type: 'toolCall', id: 't1', name: 'read', arguments: {} }]);
  reply([{ type: 'text', text: 'Finished: tests pass.' }]);
  assert.equal(sent.length, 0);
});
