import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';

import { createSink } from '../../../scripts/orchestrate/consoleSink.mjs';

// The dev orchestrator's .mjs sink — the process that actually writes to the
// console — carried the same two write-completion bugs `backend/src/consoleSink.ts`
// did (see consoleSinkWriteErrors.test.ts). The sink calls `fs.write` through
// the shared `node:fs` module object, so swapping the property drives its
// completion paths deterministically. Each test uses its own fake fd.

type WriteCb = (err: NodeJS.ErrnoException | null, written: number) => void;
const realWrite = fsSync.write;

function withFakeWrite(impl: (fd: number, buf: Buffer, cb: WriteCb) => void): () => void {
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

// A non-blocking piped fd answers a full pipe with EAGAIN; that chunk used to
// be discarded like EPIPE, silently losing every burst past the pipe buffer.
test('orchestrator sink: EAGAIN retries the chunk instead of dropping it', async () => {
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
    const sink = createSink(9201);
    sink.write('first\n');
    sink.write('second\n');
    await until(() => out.join('') === 'first\nsecond\n');
  } finally {
    restore();
  }
});

// A short write re-queued its tail at the BACK, behind output logged while the
// write was in flight — splitting a line around newer output.
test('orchestrator sink: a short write keeps the tail ahead of output queued meanwhile', async () => {
  const out: string[] = [];
  let first = true;
  const sink = createSink(9202);
  const restore = withFakeWrite((_fd, buf, cb) => {
    if (first) {
      first = false;
      out.push(buf.subarray(0, 4).toString('utf8'));
      sink.write('later\n');
      setImmediate(() => cb(null, 4));
      return;
    }
    out.push(buf.toString('utf8'));
    setImmediate(() => cb(null, buf.length));
  });
  try {
    sink.write('abcdefgh\n');
    await until(() => out.join('').length === 'abcdefgh\nlater\n'.length);
    assert.equal(out.join(''), 'abcdefgh\nlater\n');
  } finally {
    restore();
  }
});
