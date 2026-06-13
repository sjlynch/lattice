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
// `/`, `?`, `=`) so the hook curl can carry it unquoted.

test('encode/decode round-trips an agent token', () => {
  const payload = {
    agentId: 'push:abc123',
    projectPath: 'C:\\dev\\my project',
    label: 'push',
  };
  const token = encodeAgentToken(payload);
  assert.match(token, /^[A-Za-z0-9_-]+$/); // base64url alphabet only
  assert.deepEqual(decodeAgentToken(token), payload);
});

test('decodeAgentToken returns null on garbage', () => {
  assert.equal(decodeAgentToken('not a token!!!'), null);
  assert.equal(decodeAgentToken(''), null);
  // Valid base64url but not our shape.
  assert.equal(decodeAgentToken(Buffer.from('{"x":1}').toString('base64url')), null);
});

test('buildAgentActivityUrl embeds the token in a single path segment', () => {
  const url = buildAgentActivityUrl('http://127.0.0.1:5184', {
    agentId: 'wf:run1:2',
    projectPath: 'C:\\dev\\lattice',
    label: 'workflow step 3',
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:5184\/api\/agent-activity\/[A-Za-z0-9_-]+$/);
  // No shell/URL-special chars that would break an unquoted curl arg.
  const tail = url.split('/api/agent-activity/')[1];
  assert.ok(!/[&?=/]/.test(tail));
});
