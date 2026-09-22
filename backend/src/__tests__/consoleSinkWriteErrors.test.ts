import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';

import { sinkState, writeToSink } from '../consoleSink.js';

// consoleSink calls `fs.write` through the shared `node:fs` module object, so
// swapping the property here drives its completion paths deterministically.
// Each test uses its own fake fd so sinks don't share state.

type WriteCb = (err: NodeJS.ErrnoException | null, written: number) => void;
const realWrite = fsSync.write;

function withFakeWrite(
  impl: (fd: number, buf: Buffer, cb: WriteCb) => void,
): () => void {
  (fsSync as unknown as { write: unknown }).write = (fd: number, buf: Buffer, cb: WriteCb) =>
    impl(fd, buf, cb);
  return () => {
    (fsSync as unknown as { write: unknown }).write = realWrite;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(5);
  }
}

// Regression: on POSIX, fd 1/2 of a piped process is O_NONBLOCK once
// `process.stdout` is touched, so a full pipe answers the thread-pool write
// with EAGAIN. That was treated like EPIPE and the chunk silently discarded —
// every log burst past the reader's 64KB buffer was lost, uncounted.
test('EAGAIN retries the chunk instead of dropping it', async () => {
  const fd = 9101;
  const out: string[] = [];
  let refusals = 2;
  const restore = withFakeWrite((_fd, buf, cb) => {
    if (refusals > 0) {
      refusals--;
      const err = Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
      setImmediate(() => cb(err, 0));
      return;
    }
    out.push(buf.toString('utf8'));
    setImmediate(() => cb(null, buf.length));
  });
  try {
    writeToSink(fd, 'first\n');
    writeToSink(fd, 'second\n');
    await until(() => out.join('') === 'first\nsecond\n');
    assert.equal(sinkState(fd).dropped, 0);
  } finally {
    restore();
  }
});

// Regression: a short write re-queued its unwritten tail at the BACK, behind
// anything logged while the write was in flight — splitting a line around
// newer output.
test('a short write keeps the tail ahead of output queued meanwhile', async () => {
  const fd = 9102;
  const out: string[] = [];
  let first = true;
  const restore = withFakeWrite((_fd, buf, cb) => {
    if (first) {
      first = false;
      out.push(buf.subarray(0, 4).toString('utf8'));
      // Something else logs while this write is still in flight.
      writeToSink(fd, 'later\n');
      setImmediate(() => cb(null, 4));
      return;
    }
    out.push(buf.toString('utf8'));
    setImmediate(() => cb(null, buf.length));
  });
  try {
    writeToSink(fd, 'abcdefgh\n');
    await until(() => out.join('').length === 'abcdefgh\nlater\n'.length);
    assert.equal(out.join(''), 'abcdefgh\nlater\n');
  } finally {
    restore();
  }
});
