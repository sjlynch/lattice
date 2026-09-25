import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  RESTART_EXIT_CODE,
  afterPreflight,
  forwardedExitCode,
  parseConsoleCommand,
  readLines,
  relaunchAfterOrchestrator,
  waitForExit,
} from '../../../scripts/orchestrate/devControl.mjs';

// The dev console's soft restart: `r` restarts the dev stack WITHOUT the
// terminal-server `/shutdown` a Ctrl+C sends, so running agents are re-adopted
// instead of killed. These cover the pure pieces: command parsing, the
// devLoop's relaunch decisions, and the line reader both ends share.

test('parseConsoleCommand maps the console letters and words', () => {
  assert.deepEqual(parseConsoleCommand('r'), { kind: 'restart', force: false });
  assert.deepEqual(parseConsoleCommand('  Restart \r'), { kind: 'restart', force: false });
  assert.deepEqual(parseConsoleCommand('r!'), { kind: 'restart', force: true });
  assert.deepEqual(parseConsoleCommand('d'), { kind: 'detach', force: false });
  assert.deepEqual(parseConsoleCommand('detach!'), { kind: 'detach', force: true });
  assert.deepEqual(parseConsoleCommand('i'), { kind: 'deps' });
  assert.deepEqual(parseConsoleCommand('install'), { kind: 'deps' });
  assert.deepEqual(parseConsoleCommand('?'), { kind: 'help' });
  assert.deepEqual(parseConsoleCommand(''), { kind: 'none' });
  assert.deepEqual(parseConsoleCommand(null), { kind: 'none' });
  assert.deepEqual(parseConsoleCommand('q'), { kind: 'unknown', text: 'q' });
  // Force only means something for the commands that check run.lock.
  assert.deepEqual(parseConsoleCommand('i!'), { kind: 'unknown', text: 'i!' });
});

test('devLoop relaunches only on the dedicated exit code', () => {
  assert.equal(relaunchAfterOrchestrator(RESTART_EXIT_CODE), 'relaunch');
  assert.equal(relaunchAfterOrchestrator(0), 'exit');
  assert.equal(relaunchAfterOrchestrator(1), 'exit');
  assert.equal(relaunchAfterOrchestrator(null), 'exit');
});

test('a failed preflight stops a first boot but not a soft restart', () => {
  assert.equal(afterPreflight(0, { softRestart: false }), 'continue');
  assert.equal(afterPreflight(1, { softRestart: false }), 'exit');
  assert.equal(afterPreflight(0, { softRestart: true }), 'continue');
  // Agents are waiting in the surviving terminal-server to be re-adopted;
  // a locked native module must not leave them with no backend at all.
  assert.equal(afterPreflight(1, { softRestart: true }), 'continue-degraded');
});

test("a child's exit code 75 is never forwarded as a soft-restart request", () => {
  assert.equal(forwardedExitCode(RESTART_EXIT_CODE), 1);
  assert.equal(forwardedExitCode(0), 0);
  assert.equal(forwardedExitCode(3), 3);
  assert.equal(forwardedExitCode(null), 0);
  assert.equal(forwardedExitCode(undefined), 0);
});

test('readLines splits chunked input into CR-stripped lines and flushes the tail on end', async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  readLines(stream, (line) => lines.push(line));
  stream.write('so');
  stream.write('ft-stop\r\ndeps-');
  stream.write(Buffer.from('recheck\n'));
  stream.end('tail');
  await new Promise((resolve) => stream.on('end', resolve));
  assert.deepEqual(lines, ['soft-stop', 'deps-recheck', 'tail']);
});

test('readLines splits a multi-byte character across chunks correctly', async () => {
  const stream = new PassThrough();
  const lines: string[] = [];
  readLines(stream, (line) => lines.push(line));
  const bytes = Buffer.from('é\n', 'utf8');
  stream.write(bytes.subarray(0, 1));
  stream.end(bytes.subarray(1));
  await new Promise((resolve) => stream.on('end', resolve));
  assert.deepEqual(lines, ['é']);
});

function fakeChild() {
  return Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null });
}

test('waitForExit resolves true on exit and false on timeout', async () => {
  const child = fakeChild();
  const waiting = waitForExit(child, 1000);
  child.emit('exit', 0, null);
  assert.equal(await waiting, true);

  const stuck = fakeChild();
  assert.equal(await waitForExit(stuck, 5), false);
  assert.equal(stuck.listenerCount('exit'), 0);

  const gone = Object.assign(fakeChild(), { exitCode: 0 });
  assert.equal(await waitForExit(gone, 1000), true);
  assert.equal(await waitForExit(null, 1000), true);
});
