// The generated lattice-guard.ts: blocks whole-filesystem scans (a small model's
// `find / -name x` hung an unattended session for 80 min) and gives untimed
// bash calls a timeout; leaves everything else alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PI_DEFAULT_BASH_TIMEOUT_SECONDS,
  PI_WHOLE_FS_SCAN_PATTERN,
  renderPiGuardExtension,
} from '../piGuard.js';

test('the pattern catches root, drive and home scans, not scoped ones', () => {
  for (const cmd of [
    'find / -name create-task.cjs',
    'cd x && find / -name write.mjs 2>/dev/null',
    'find /c -name "*.ts"',
    'find C:/ -iname foo',
    'find ~ -name run.sh',
    'ls -laR /',
    'du -sh /',
  ]) assert.ok(PI_WHOLE_FS_SCAN_PATTERN.test(cmd), cmd);
  for (const cmd of [
    'find . -name x',
    'find ./src -name "*.ts"',
    'find /c/development/lattice -name x',
    'ls -la',
    'du -sh node_modules',
    'git log --format=%H -- backend/',
  ]) assert.ok(!PI_WHOLE_FS_SCAN_PATTERN.test(cmd), cmd);
  // A quoted mention is blocked too — rare, and the reason tells the agent how to proceed.
});

async function load() {
  const url = `data:text/javascript;base64,${Buffer.from(renderPiGuardExtension()).toString('base64')}`;
  const mod = (await import(url)) as { default: (pi: unknown) => void };
  let handler: ((e: unknown) => unknown) | undefined;
  mod.default({ on: (name: string, fn: (e: unknown) => unknown) => { if (name === 'tool_call') handler = fn; } });
  return handler!;
}

test('blocks a whole-filesystem scan with a scoped alternative', async () => {
  const onCall = await load();
  const res = onCall({ toolName: 'bash', input: { command: 'find / -name x' } }) as { block: boolean; reason: string };
  assert.equal(res.block, true);
  assert.match(res.reason, /find \. -name/);
});

test('defaults an untimed bash call; keeps an explicit timeout and other tools', async () => {
  const onCall = await load();
  const untimed = { toolName: 'bash', input: { command: 'npm test' } as Record<string, unknown> };
  assert.equal(onCall(untimed), undefined);
  assert.equal(untimed.input.timeout, PI_DEFAULT_BASH_TIMEOUT_SECONDS);
  const timed = { toolName: 'bash', input: { command: 'npm test', timeout: 30 } };
  onCall(timed);
  assert.equal(timed.input.timeout, 30);
  const read = { toolName: 'read', input: { path: 'x' } as Record<string, unknown> };
  assert.equal(onCall(read), undefined);
  assert.equal(read.input.timeout, undefined);
});
