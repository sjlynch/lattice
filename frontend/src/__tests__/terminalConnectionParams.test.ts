import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTerminalWsQuery } from '../components/terminal/connectionParams.ts';

// Regression for: "a brand-new sidebar terminal disposes and recreates its
// entire xterm instance the moment it captures its serverId."
//
// The structural fix (serverId removed from useTerminalLifecycle /
// useActiveTerminalWebgl deps, and read through a ref in useTerminalConnection)
// can't be exercised here — the frontend test harness is pure node:test with no
// DOM/canvas, so a real <TerminalPane> (xterm needs `term.open(el)`) can't be
// mounted. What *is* testable is the load-bearing connection-param contract that
// the ref-read preserves: once a serverless terminal CAPTURES a session id, a
// reconnect must re-attach to the EXISTING pty by id rather than re-running the
// initialCommand and spawning a second pty.

function parse(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

test('serverless connect carries initialCommand and no id', () => {
  const q = parse(
    buildTerminalWsQuery({
      cwd: 'C:/proj',
      cols: 80,
      rows: 24,
      initialCommand: 'npm run dev',
      projectPath: 'C:/proj',
    }),
  );
  assert.equal(q.get('id'), null);
  assert.equal(q.get('initialCommand'), 'npm run dev');
  assert.equal(q.get('cwd'), 'C:/proj');
  assert.equal(q.get('cols'), '80');
  assert.equal(q.get('rows'), '24');
  assert.equal(q.get('projectPath'), 'C:/proj');
});

test('a captured serverId re-attaches by id and drops the initialCommand', () => {
  // This is the post-capture reconnect: serverIdRef now holds the id, so we must
  // re-subscribe to the existing pty (id present) and NOT re-send the command
  // (which would spawn a second `npm run dev` and fail "address in use").
  const q = parse(
    buildTerminalWsQuery({
      cwd: 'C:/proj',
      cols: 80,
      rows: 24,
      serverId: 'srv-123',
      initialCommand: 'npm run dev',
      projectPath: 'C:/proj',
    }),
  );
  assert.equal(q.get('id'), 'srv-123');
  assert.equal(q.get('initialCommand'), null);
});

test('capture flips the query from fresh-spawn to re-attach', () => {
  // Models the serverless → captured-id transition the bug is about. The first
  // (serverless) connect spawns the pty; after capturing its id, the SAME
  // terminal's next connect must re-attach to that exact pty.
  const base = { cwd: 'C:/proj', cols: 80, rows: 24, initialCommand: 'pi' };
  const beforeCapture = parse(buildTerminalWsQuery(base));
  const afterCapture = parse(buildTerminalWsQuery({ ...base, serverId: 'srv-abc' }));

  assert.equal(beforeCapture.get('id'), null);
  assert.equal(beforeCapture.get('initialCommand'), 'pi');

  assert.equal(afterCapture.get('id'), 'srv-abc');
  assert.equal(afterCapture.get('initialCommand'), null);
});

test('projectPath is optional and omitted when absent', () => {
  const q = parse(buildTerminalWsQuery({ cwd: 'C:/proj', cols: 1, rows: 1 }));
  assert.equal(q.get('projectPath'), null);
  assert.equal(q.get('id'), null);
  assert.equal(q.get('initialCommand'), null);
});
