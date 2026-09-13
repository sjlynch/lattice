import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalActivityRelayObserver,
  getObservedTerminalTitle,
} from '../terminalActivityRelay.js';

const frame = (data: string) => JSON.stringify({ type: 'data', data });
const attached = (id: string, replayed = true) => JSON.stringify({ type: 'attached', id, replayed });
const title = (value: string) => `\x1b]0;${value}\x07`;

test('relay facts bind only to the executor handshake and use the final replay title', (t) => {
  const observer = createTerminalActivityRelayObserver();
  t.after(observer.dispose);
  observer.observe(frame(title('Working')));
  for (const invalid of ['null', '{}', '[{}]', '{', attached('')]) observer.observe(invalid);
  assert.equal(observer.sessionId, null);
  assert.equal(getObservedTerminalTitle('relay-handshake'), undefined);
  observer.observe(attached('relay-handshake', false));
  assert.equal(observer.sessionId, 'relay-handshake');
  assert.equal(getObservedTerminalTitle('relay-handshake'), null);
  observer.observe(frame(`${title('Working')}old transcript${title('Ready')}`));
  assert.equal(getObservedTerminalTitle('relay-handshake'), 'Ready');
  observer.observe(attached('unexpected-second-id'));
  observer.observe(frame(title('Working')));
  assert.equal(getObservedTerminalTitle('unexpected-second-id'), undefined);
  assert.equal(getObservedTerminalTitle('relay-handshake'), 'Working');
});

test('separate viewers keep split OSC parsing independent and promote a live observer', (t) => {
  const first = createTerminalActivityRelayObserver();
  const second = createTerminalActivityRelayObserver();
  t.after(first.dispose);
  t.after(second.dispose);
  first.observe(attached('relay-shared'));
  first.observe(frame(title('Ready')));
  second.observe(attached('relay-shared'));
  second.observe(frame(title('Working')));
  assert.equal(getObservedTerminalTitle('relay-shared'), 'Ready', 'joining replay cannot replace the live owner');
  first.observe(frame('\x1b]2;Wor'));
  second.observe(frame('\x1b]0;Re'));
  first.observe(frame('king\x1b'));
  second.observe(frame('ady\x07'));
  assert.equal(getObservedTerminalTitle('relay-shared'), 'Ready', 'an incomplete title is not committed');
  first.observe(frame('\\'));
  assert.equal(getObservedTerminalTitle('relay-shared'), 'Working');
  first.dispose();
  assert.equal(getObservedTerminalTitle('relay-shared'), 'Ready', 'the remaining viewer already has its own current parser');
  first.dispose();
  first.observe(frame(title('Working')));
  assert.equal(getObservedTerminalTitle('relay-shared'), 'Ready');
  second.dispose();
  assert.equal(getObservedTerminalTitle('relay-shared'), undefined);

  const replacement = createTerminalActivityRelayObserver();
  t.after(replacement.dispose);
  replacement.observe(attached('relay-shared'));
  replacement.observe(frame(title('Working')));
  first.dispose();
  second.dispose();
  assert.equal(getObservedTerminalTitle('relay-shared'), 'Working', 'old teardown cannot delete a replacement');
});

test('exit, session_lost and disposal permanently retire only their observation', (t) => {
  for (const end of ['exit', 'session_lost', 'dispose']) {
    const id = `relay-end-${end}`;
    const observer = createTerminalActivityRelayObserver();
    t.after(observer.dispose);
    observer.observe(attached(id));
    observer.observe(frame(title('Working')));
    assert.equal(getObservedTerminalTitle(id), 'Working');
    if (end === 'dispose') observer.dispose();
    else observer.observe(JSON.stringify({ type: end }));
    assert.equal(getObservedTerminalTitle(id), undefined);
    observer.observe(attached(id));
    observer.observe(frame(title('Working')));
    assert.equal(getObservedTerminalTitle(id), undefined);
  }
});

test('plain chunks inside pending escapes still update titles and C1 titles are recognized', (t) => {
  const observer = createTerminalActivityRelayObserver();
  t.after(observer.dispose);
  observer.observe(attached('relay-plain-chunks'));
  observer.observe(frame('ordinary log output\n'.repeat(10_000)));
  assert.equal(getObservedTerminalTitle('relay-plain-chunks'), null);
  observer.observe(frame('\x1b]0;'));
  observer.observe(frame('Working'));
  observer.observe(frame('\x07'));
  assert.equal(getObservedTerminalTitle('relay-plain-chunks'), 'Working');
  observer.observe(frame('plain text mentioning Ready'));
  assert.equal(getObservedTerminalTitle('relay-plain-chunks'), 'Working');
  observer.observe(frame('\x9d2;'));
  observer.observe(frame('Ready'));
  observer.observe(frame('\x9c'));
  assert.equal(getObservedTerminalTitle('relay-plain-chunks'), 'Ready');
});

test('large replay, malformed envelopes and bounded titles preserve observation safety', (t) => {
  const observer = createTerminalActivityRelayObserver();
  t.after(observer.dispose);
  observer.observe(attached('relay-large'));
  const replay = `${title('Working')}${'x'.repeat(1_999_950)}${title('Ready')}`;
  observer.observe(frame(replay));
  assert.equal(getObservedTerminalTitle('relay-large'), 'Ready');
  for (const invalid of ['{', 'null', '42', '[]', '{"type":"data","data":{}}']) observer.observe(invalid);
  assert.equal(getObservedTerminalTitle('relay-large'), 'Ready');
  observer.observe(frame(title(`Working${'x'.repeat(200_000)}`)));
  assert.equal(getObservedTerminalTitle('relay-large'), null, 'oversized titles never become truncated status matches');
  observer.observe(frame(`\x1b]52;c;${'x'.repeat(200_000)}\x07${title('Working')}`));
  assert.equal(getObservedTerminalTitle('relay-large'), 'Working');
});
