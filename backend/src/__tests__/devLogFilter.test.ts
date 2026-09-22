import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { isContinuation, prefixLines } from '../../../scripts/orchestrate/logFilter.mjs';

// The orchestrator's vite proxy-error suppression: a `[vite] … proxy error`
// line opens a suppressed block that swallows the error header, stack frames,
// error-object props and braces; the first unrelated line closes it and is
// emitted. This is what keeps a backend restart from flooding the console.

test('isContinuation recognises the lines of a proxy-error block', () => {
  for (const line of [
    '',
    '   ',
    'Error: connect ECONNREFUSED 127.0.0.1:5184',
    '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1595:16)',
    '  errno: -4078,',
    "  code: 'ECONNREFUSED',",
    "  syscall: 'connect',",
    "  address: '127.0.0.1',",
    '  port: 5184',
    ' {',
    '}',
  ]) {
    assert.equal(isContinuation(line), true, JSON.stringify(line));
  }
  for (const line of [
    '[vite] hmr update /src/App.tsx',
    'ready in 300 ms',
    'Errors: 3', // not the `Error:` header
    'at the end of the day', // not indented
  ]) {
    assert.equal(isContinuation(line), false, JSON.stringify(line));
  }
});

function capture(opts: { filterViteProxy?: boolean } = {}) {
  const stream = new PassThrough();
  const out: string[] = [];
  prefixLines(stream, { write: (s: string) => { out.push(s); } }, { label: 'frontend', color: '', filterViteProxy: true, ...opts });
  return { stream, out };
}

const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (out: string[]) => out.map((s) => s.replace(ANSI, '').replace(/^\[frontend\] /, '').replace(/\n$/, ''));

test('prefixLines suppresses a whole proxy-error block and resumes at the first unrelated line', async () => {
  const { stream, out } = capture();
  stream.write(
    [
      'before',
      '\x1b[31m[vite] http proxy error: /api/scan\x1b[0m',
      'Error: connect ECONNREFUSED 127.0.0.1:5184',
      '    at TCPConnectWrap.afterConnect (node:net:1595:16) {',
      '  errno: -4078,',
      "  code: 'ECONNREFUSED',",
      '}',
      '',
      'after',
      '',
    ].join('\n'),
  );
  stream.end();
  await new Promise((r) => stream.on('end', r));
  assert.deepEqual(plain(out), ['before', 'after']);
});

test('prefixLines treats a second trigger inside a suppressed block as extending it, not closing it', async () => {
  const { stream, out } = capture();
  stream.write(
    [
      '[vite] ws proxy error:',
      'Error: connect ECONNREFUSED 127.0.0.1:5184',
      '[vite] http proxy error: /api/health',
      'Error: connect ECONNREFUSED 127.0.0.1:5184',
      '    at x',
      'visible',
      '',
    ].join('\n'),
  );
  stream.end();
  await new Promise((r) => stream.on('end', r));
  assert.deepEqual(plain(out), ['visible']);
});

test('prefixLines buffers partial lines across chunks, handles CRLF, and flushes the tail on end', async () => {
  const { stream, out } = capture({ filterViteProxy: false });
  stream.write('one\r\ntw');
  stream.write('o\nthree');
  stream.end();
  await new Promise((r) => stream.on('end', r));
  assert.deepEqual(plain(out), ['one', 'two', 'three']);
  // `<color>[label]<reset> line\n` — the prefix/newline contract the console relies on.
  assert.ok(out.every((s) => s.replace(ANSI, '').startsWith('[frontend] ') && s.endsWith('\n')));
});

test('prefixLines without filterViteProxy emits proxy errors verbatim', async () => {
  const { stream, out } = capture({ filterViteProxy: false });
  stream.write('[vite] http proxy error: /api/x\nError: boom\n');
  stream.end();
  await new Promise((r) => stream.on('end', r));
  assert.deepEqual(plain(out), ['[vite] http proxy error: /api/x', 'Error: boom']);
});
