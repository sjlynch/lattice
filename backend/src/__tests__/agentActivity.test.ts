import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import {
  buildAgentActivityUrl,
  decodeAgentToken,
  encodeAgentToken,
} from '../agentActivityTokens.js';
import { buildAgentActivityRouter } from '../routes/agentActivity.js';
import { agentQuiescence, forgetAgentQuiescence } from '../agentQuiescence.js';

// The agent-activity token round-trips the routing info (agent id, project,
// label) through a URL-path-safe string. It must survive a Windows project
// path with backslashes and stay free of shell/URL-special chars (no `&`,
// `/`, `?`, `=`) so the hook curl can carry it unquoted. It is HMAC-signed
// (`<payload>.<signature>`) so a forged payload can't drive graph events.

test('encode/decode round-trips an agent token', () => {
  const payload = {
    agentId: 'push:abc123',
    projectPath: 'C:\\dev\\my project',
    label: 'push',
  };
  const token = encodeAgentToken(payload);
  // base64url payload + `.` + base64url signature, nothing else.
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeAgentToken(token), payload);
});

test('decodeAgentToken returns null on garbage', () => {
  assert.equal(decodeAgentToken('not a token!!!'), null);
  assert.equal(decodeAgentToken(''), null);
  // Valid base64url but not our shape.
  assert.equal(decodeAgentToken(Buffer.from('{"x":1}').toString('base64url')), null);
});

test('decodeAgentToken rejects an unsigned (old-scheme) token', () => {
  // A bare base64url payload with no `.<signature>` — the pre-HMAC format.
  const body = Buffer.from(
    JSON.stringify({ a: 'push:x', p: 'C:\\dev', l: 'push' }),
    'utf8',
  ).toString('base64url');
  assert.equal(decodeAgentToken(body), null);
});

test('decodeAgentToken rejects a tampered payload or signature', () => {
  const token = encodeAgentToken({
    agentId: 'push:abc',
    projectPath: 'C:\\dev\\lattice',
    label: 'push',
  });
  const [body, sig] = token.split('.');

  // Forge a different payload but keep the original signature.
  const forged = Buffer.from(
    JSON.stringify({ a: 'attacker', p: 'C:\\dev\\lattice', l: 'push' }),
    'utf8',
  ).toString('base64url');
  assert.equal(decodeAgentToken(`${forged}.${sig}`), null);

  // Tamper with the signature; payload intact.
  const flipped = sig[0] === 'A' ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(decodeAgentToken(`${body}.${flipped}`), null);

  // Stray extra separator.
  assert.equal(decodeAgentToken(`${body}.${sig}.x`), null);
});

test('buildAgentActivityUrl embeds the token in a single path segment', () => {
  const url = buildAgentActivityUrl('http://127.0.0.1:5184', {
    agentId: 'wf:run1:2',
    projectPath: 'C:\\dev\\lattice',
    label: 'workflow step 3',
  });
  assert.match(
    url,
    /^http:\/\/127\.0\.0\.1:5184\/api\/agent-activity\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  );
  // No shell/URL-special chars that would break an unquoted curl arg.
  const tail = url.split('/api/agent-activity/')[1];
  assert.ok(!/[&?=/]/.test(tail));
});

// The Stop-hook quiescence gate reads `lastSignalAt` from this route. The
// signal used to be recorded only when the hook produced a GRAPH event — null
// for a file under a managed path or outside the project, which is exactly
// where a workflow-step agent works (its `.lattice/workflow-steps/…` dir). The
// gate then saw a "quiet" session that was still busy and advanced the run.
test('a hook on a managed or out-of-project path still refreshes the quiescence tracker', async () => {
  const projectPath = path.join(os.tmpdir(), `lattice-agent-activity-${process.pid}`);
  const agentId = `wf:run_${Date.now()}:0`;
  const token = encodeAgentToken({ agentId, projectPath, label: 'workflow step 1' });
  const app = express();
  app.use(express.json());
  app.use(buildAgentActivityRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const post = (body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/agent-activity/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(agentQuiescence(agentId).quietForMs, Number.POSITIVE_INFINITY);

    // Managed path inside the project: no graph event, still a live signal.
    let res = await post({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      cwd: projectPath,
      tool_input: {
        file_path: path.join(projectPath, '.lattice', 'workflow-steps', 'run', 'step-0', 'tasks.json'),
      },
    });
    assert.equal(res.status, 204);
    assert.ok(agentQuiescence(agentId).quietForMs < 5000);

    // Subagent lifecycle without an `agent_id` (dropped by the graph) still
    // moves the live-subagent count the gate rejects a premature Stop on.
    res = await post({ hook_event_name: 'SubagentStart', cwd: projectPath });
    assert.equal(res.status, 204);
    assert.equal(agentQuiescence(agentId).liveSubagents, 1);
    res = await post({ hook_event_name: 'SubagentStop', cwd: projectPath });
    assert.equal(res.status, 204);
    assert.equal(agentQuiescence(agentId).liveSubagents, 0);

    // Entirely outside the project: same.
    forgetAgentQuiescence(agentId);
    res = await post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      cwd: os.tmpdir(),
      tool_input: { file_path: path.join(os.tmpdir(), 'elsewhere', 'notes.md') },
    });
    assert.equal(res.status, 204);
    assert.ok(agentQuiescence(agentId).quietForMs < 5000);
  } finally {
    forgetAgentQuiescence(agentId);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
