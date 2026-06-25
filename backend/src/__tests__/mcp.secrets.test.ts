// MCP secret redaction: never the value, just presence + last-4. Split out of
// the original monolithic mcp.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, secretHints } from '../mcp/secrets.js';

test('redactSecrets reduces values to presence booleans', () => {
  const redacted = redactSecrets({ brave: { BRAVE_API_KEY: 'sk-supersecret' } });
  assert.deepEqual(redacted, { brave: { BRAVE_API_KEY: true } });
});

test('secretHints reveals only the last 4 characters', () => {
  const hints = secretHints({ brave: { BRAVE_API_KEY: 'sk-abcd1234wxyz' } });
  assert.equal(hints.brave.BRAVE_API_KEY, '••••wxyz');
});
