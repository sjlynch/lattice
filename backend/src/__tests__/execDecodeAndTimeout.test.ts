// worktree/exec.ts + spawnWithTimeout.ts regressions:
//   1. Output was decoded chunk-by-chunk (`d.toString()`), so a multi-byte
//      UTF-8 character split across two pipe reads became two U+FFFD
//      replacement chars — a non-ASCII path in `ls-files -z` /
//      `worktree list -z` output then silently stopped matching.
//   2. A timeout killed the child but still waited for 'close', which only
//      fires once EVERY holder of the stdio pipes exits. A grandchild that
//      inherited them (a git hook, a credential helper) kept the promise —
//      and the cleanup/merge awaiting it — pending well past the timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exec, EXEC_KILL_GRACE_MS } from '../worktree/exec.js';
import { spawnWithTimeout } from '../spawnWithTimeout.js';

// Writes "é" (0xC3 0xA9) as two separate writes 150 ms apart so the parent
// receives the two bytes in different 'data' chunks.
const SPLIT_UTF8_SCRIPT =
  "process.stdout.write(Buffer.from([0x61,0xc3]));" +
  "setTimeout(()=>process.stdout.write(Buffer.from([0xa9,0x62])),150)";

test('exec decodes a UTF-8 character split across pipe chunks', async () => {
  const r = await exec(process.execPath, ['-e', SPLIT_UTF8_SCRIPT], process.cwd());
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'aéb');
});

test('spawnWithTimeout decodes a UTF-8 character split across pipe chunks', async () => {
  const r = await spawnWithTimeout(process.execPath, ['-e', SPLIT_UTF8_SCRIPT], { timeoutMs: 10_000 });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'aéb');
  assert.equal(r.combined, 'aéb');
});

test('exec timeout resolves even when a grandchild keeps the stdio pipes open', async () => {
  // The child spawns a grandchild that inherits stdout/stderr and lives for
  // 8 s, then idles itself. The timeout kills only the child.
  const grandchildMs = 8_000;
  const script =
    "require('child_process').spawn(process.execPath," +
    `['-e','setTimeout(()=>{},${grandchildMs})'],{stdio:'inherit'});` +
    'setInterval(()=>{},1000)';
  const started = Date.now();
  const r = await exec(process.execPath, ['-e', script], process.cwd(), { timeoutMs: 300 });
  const elapsed = Date.now() - started;
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /killed after 300ms timeout/);
  assert.ok(
    elapsed < 300 + EXEC_KILL_GRACE_MS + 2_000,
    `exec stayed pending ${elapsed}ms — bounded by the grandchild, not the timeout`,
  );
});
