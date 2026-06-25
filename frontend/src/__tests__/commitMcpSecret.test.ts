import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitMcpSecret } from '../components/settings/mcp/commitMcpSecret.ts';

test('a rejected save surfaces the error instead of swallowing it', async () => {
  const result = await commitMcpSecret('brave-search', 'BRAVE_API_KEY', 'k', () =>
    Promise.reject(new Error('permission denied')),
  );
  assert.deepEqual(result, { ok: false, error: 'permission denied' });
});

test('a rejection with no message falls back to a generic, non-empty error', async () => {
  const result = await commitMcpSecret('brave-search', 'BRAVE_API_KEY', 'k', () =>
    Promise.reject(new Error('   ')),
  );
  assert.equal(result.ok, false);
  // The field must always have *something* to show — never a blank error.
  assert.ok(!result.ok && result.error.trim().length > 0);
});

test('a successful save reports ok and forwards the secret to the saver', async () => {
  let calledWith: unknown[] | null = null;
  const result = await commitMcpSecret(
    'brave-search',
    'BRAVE_API_KEY',
    'secret',
    (...args: unknown[]) => {
      calledWith = args;
      return Promise.resolve({ redacted: {} });
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calledWith, ['brave-search', 'BRAVE_API_KEY', 'secret']);
});
