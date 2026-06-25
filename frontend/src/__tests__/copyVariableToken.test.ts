import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyVariableToken } from '../components/workflows/promptVariables.ts';

// A minimal stand-in for the part of navigator.clipboard we use.
function stubClipboard(writeText: (text: string) => Promise<void>) {
  return { writeText } as Pick<Clipboard, 'writeText'>;
}

test('successful write resolves true and copies the {{token}}', async () => {
  const writes: string[] = [];
  const clipboard = stubClipboard(async (text) => {
    writes.push(text);
  });
  const ok = await copyVariableToken('my_var', clipboard);
  assert.equal(ok, true);
  assert.deepEqual(writes, ['{{my_var}}']);
});

// The bug this guards: a rejected writeText (permission denial / non-secure
// context / unfocused document) must NOT report success, so the UI never shows
// a false "Copied!".
test('rejected write resolves false (no false success feedback)', async () => {
  const clipboard = stubClipboard(async () => {
    throw new Error('NotAllowedError');
  });
  const ok = await copyVariableToken('my_var', clipboard);
  assert.equal(ok, false);
});

test('empty name is a no-op that never touches the clipboard', async () => {
  let called = false;
  const clipboard = stubClipboard(async () => {
    called = true;
  });
  const ok = await copyVariableToken('', clipboard);
  assert.equal(ok, false);
  assert.equal(called, false);
});

test('absent Clipboard API resolves false without throwing', async () => {
  const ok = await copyVariableToken('my_var', undefined);
  assert.equal(ok, false);
});
