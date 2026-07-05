import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RgPathCollector } from '../ripgrep.js';

// Regression: `searchWithRipgrep` used to push every rg stdout chunk into an
// array, `Buffer.concat` at close, and only THEN slice to `limit`. A broad
// query (`q=e&limit=1`) in a large repo forced Node to buffer/parse thousands of
// matching paths even though the caller wanted one — defeating the endpoint's
// cap. `RgPathCollector` now parses the NUL-delimited stream incrementally, caps
// `matches` at `limit`, and signals "stop" the moment one path beyond the cap
// arrives so the caller can kill rg early. These tests pin that behaviour
// without spawning a process (see ripgrepEarlyExit.test.ts for the end-to-end
// kill), so they run identically on every platform.

const ROOT = path.resolve('/repo/root');
const abs = (name: string): string => path.resolve(ROOT, name);
const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

test('collects fewer-than-limit paths without truncation', () => {
  const c = new RgPathCollector(ROOT, 5);
  assert.equal(c.push(buf('a.ts\0b.ts\0')), false);
  c.end();
  assert.deepEqual(c.matches, [abs('a.ts'), abs('b.ts')]);
  assert.equal(c.truncated, false);
  assert.equal(c.done, false);
});

test('exactly `limit` complete paths is NOT truncated', () => {
  const c = new RgPathCollector(ROOT, 2);
  // Two paths, each NUL-terminated, and nothing after: rg emitted exactly the
  // cap, so there is no "one more" to prove truncation.
  assert.equal(c.push(buf('a.ts\0b.ts\0')), false);
  c.end();
  assert.deepEqual(c.matches, [abs('a.ts'), abs('b.ts')]);
  assert.equal(c.truncated, false);
});

test('one path beyond `limit` marks truncated and signals stop', () => {
  const c = new RgPathCollector(ROOT, 2);
  // The 3rd complete path is the trigger — push() returns true so the caller
  // kills rg. matches stays capped at the limit.
  assert.equal(c.push(buf('a.ts\0b.ts\0c.ts\0')), true);
  assert.equal(c.done, true);
  assert.equal(c.truncated, true);
  assert.deepEqual(c.matches, [abs('a.ts'), abs('b.ts')]);
});

test('a path split across chunk boundaries is reassembled via the carry', () => {
  const c = new RgPathCollector(ROOT, 5);
  c.push(buf('src/comp')); // no NUL yet — held in carry
  c.push(buf('onent.ts\0src/ind'));
  c.push(buf('ex.ts\0'));
  c.end();
  assert.deepEqual(c.matches, [abs('src/component.ts'), abs('src/index.ts')]);
  assert.equal(c.truncated, false);
});

test('a multi-byte UTF-8 code point split across chunks is not corrupted', () => {
  const c = new RgPathCollector(ROOT, 5);
  // "café.ts\0" — the é is 0xC3 0xA9 in UTF-8. Split the buffer *inside* that
  // 2-byte sequence so a naive per-chunk toString would mangle it.
  const bytes = buf('café.ts\0');
  const eIdx = bytes.indexOf(0xc3);
  c.push(bytes.subarray(0, eIdx + 1)); // ends mid-é (only 0xC3)
  c.push(bytes.subarray(eIdx + 1)); // 0xA9 + rest
  c.end();
  assert.deepEqual(c.matches, [abs('café.ts')]);
});

test('a final path with no trailing NUL is still counted at end()', () => {
  const c = new RgPathCollector(ROOT, 5);
  c.push(buf('a.ts\0b.ts')); // b.ts has no terminator
  c.end();
  assert.deepEqual(c.matches, [abs('a.ts'), abs('b.ts')]);
  assert.equal(c.truncated, false);
});

test('empty segments (consecutive NULs) are skipped', () => {
  const c = new RgPathCollector(ROOT, 5);
  c.push(buf('a.ts\0\0b.ts\0'));
  c.end();
  assert.deepEqual(c.matches, [abs('a.ts'), abs('b.ts')]);
});

test('a huge single chunk is capped — memory stays bounded, stop fires early', () => {
  const c = new RgPathCollector(ROOT, 3);
  // Simulate rg dumping thousands of matches in one read. The collector must
  // keep at most `limit` and stop, not retain all 10k.
  const many = Array.from({ length: 10_000 }, (_, i) => `file_${i}.ts`).join('\0') + '\0';
  assert.equal(c.push(buf(many)), true);
  assert.equal(c.matches.length, 3);
  assert.equal(c.truncated, true);
  assert.deepEqual(c.matches, [abs('file_0.ts'), abs('file_1.ts'), abs('file_2.ts')]);

  // Further chunks after `done` are dropped (return true, no growth) so a
  // still-draining rg pipe can't balloon memory before the kill lands.
  assert.equal(c.push(buf('file_10001.ts\0')), true);
  assert.equal(c.matches.length, 3);
  c.end();
  assert.equal(c.matches.length, 3);
});
