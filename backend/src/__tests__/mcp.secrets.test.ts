// MCP secret redaction: never the value, just presence + last-4. Split out of
// the original monolithic mcp.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  mergeMcpSecrets,
  readMcpSecrets,
  redactSecrets,
  secretHints,
  setMcpSecret,
} from '../mcp/secrets.js';
import { latticeHomeDir } from '../projectPath.js';
import { once } from 'node:events';
import express from 'express';
import { buildMcpRouter } from '../routes/mcp.js';

// The write-path tests below touch ~/.lattice/mcpSecrets.json — never against
// a real home (see helpers/isolateHome.mjs, preloaded by `npm test`).
if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error(
    'mcp.secrets.test.ts writes under ~/.lattice — run it via `npm test` (or with ' +
      '`--import ./src/__tests__/helpers/isolateHome.mjs`), never bare `node --test`.',
  );
}

const SECRETS_FILE = () => path.join(latticeHomeDir(), 'mcpSecrets.json');

test('a secrets file that does not parse makes the writers refuse, and leaves it untouched', async () => {
  await fs.mkdir(latticeHomeDir(), { recursive: true });
  // A truncated file (a crash mid-write, a stray edit). The lenient read path
  // used to hand the writers `{}` for this, and saving ONE key then replaced
  // every other stored secret with that one.
  const broken = '{ "brave": { "BRAVE_API_KEY": "sk-keep-me"';
  await fs.writeFile(SECRETS_FILE(), broken, 'utf8');
  try {
    await assert.rejects(setMcpSecret('context7', 'CONTEXT7_API_KEY', 'sk-new'), /refusing to overwrite/);
    await assert.rejects(mergeMcpSecrets({ context7: { CONTEXT7_API_KEY: 'sk-new' } }), /refusing to overwrite/);
    assert.equal(await fs.readFile(SECRETS_FILE(), 'utf8'), broken);
    // The read path stays lenient so sessions still spawn.
    assert.deepEqual(await readMcpSecrets(), {});
  } finally {
    await fs.rm(SECRETS_FILE(), { force: true });
  }
});

test('with no secrets file yet, set then merge round-trip and keep each other', async () => {
  await fs.rm(SECRETS_FILE(), { force: true });
  try {
    assert.deepEqual(await setMcpSecret('brave', 'BRAVE_API_KEY', 'sk-1'), { brave: { BRAVE_API_KEY: true } });
    assert.deepEqual(await mergeMcpSecrets({ context7: { CONTEXT7_API_KEY: 'sk-2' } }), {
      brave: { BRAVE_API_KEY: true },
      context7: { CONTEXT7_API_KEY: true },
    });
    assert.deepEqual(await readMcpSecrets(), {
      brave: { BRAVE_API_KEY: 'sk-1' },
      context7: { CONTEXT7_API_KEY: 'sk-2' },
    });
    // A UTF-8 BOM is tolerated, not treated as corruption.
    await fs.writeFile(SECRETS_FILE(), '﻿' + JSON.stringify({ brave: { BRAVE_API_KEY: 'sk-1' } }), 'utf8');
    assert.deepEqual(await setMcpSecret('x', 'K', 'v'), { brave: { BRAVE_API_KEY: true }, x: { K: true } });
  } finally {
    await fs.rm(SECRETS_FILE(), { force: true });
  }
});

test('redactSecrets reduces values to presence booleans', () => {
  const redacted = redactSecrets({ brave: { BRAVE_API_KEY: 'sk-supersecret' } });
  assert.deepEqual(redacted, { brave: { BRAVE_API_KEY: true } });
});

test('secretHints reveals only the last 4 characters', () => {
  const hints = secretHints({ brave: { BRAVE_API_KEY: 'sk-abcd1234wxyz' } });
  assert.equal(hints.brave.BRAVE_API_KEY, '••••wxyz');
});

// Regression: `(secrets[serverId] ??= {})[envVar] = value` with serverId
// "constructor" resolved the inherited Object function and assigned
// `Object.keys = value` process-wide; "__proto__" wrote onto Object.prototype.
test('prototype-reaching secret keys are refused and never touch Object', async () => {
  await fs.rm(SECRETS_FILE(), { force: true });
  const keysBefore = Object.keys;
  await assert.rejects(setMcpSecret('constructor', 'keys', 'x'), /refusing MCP secret key/);
  await assert.rejects(setMcpSecret('__proto__', 'polluted', 'x'), /refusing MCP secret key/);
  await assert.rejects(setMcpSecret('brave', '__proto__', 'x'), /refusing MCP secret key/);
  await assert.rejects(setMcpSecret('constructor', 'hasOwnProperty', null), /refusing MCP secret key/);
  await mergeMcpSecrets({ constructor: { keys: 'x' }, brave: { BRAVE_API_KEY: 'sk-abcdefgh1234' } });
  assert.equal(Object.keys, keysBefore);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(Object.keys(await readMcpSecrets()), ['brave']);
});

test('secretHints reveals no tail for a short secret', () => {
  const hints = secretHints({ s: { SHORT: 'abcd', MID: 'abcdefgh' } });
  assert.equal(hints.s.SHORT, '••••');
  assert.equal(hints.s.MID, '••••');
});

test('PATCH /api/mcp-secrets answers 400 (not 500) for a prototype-polluting key', async () => {
  const app = express();
  app.use(express.json());
  app.use(buildMcpRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  try {
    for (const body of [
      { serverId: 'constructor', envVar: 'keys', value: 'x' },
      { serverId: 'brave', envVar: '__proto__', value: 'x' },
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/mcp-secrets`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 400);
    }
    assert.equal(typeof Object.keys, 'function');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
