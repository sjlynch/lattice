import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentActivityUrl,
  decodeAgentToken,
  encodeAgentToken,
} from '../agentActivity.js';

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
