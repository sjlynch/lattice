import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  ALLOW_WORKTREE_BACKEND_ENV,
  BootRefusedError,
  identifyListener,
  isInsideLatticeWorktree,
  liveBackendRefusal,
  probePortBindable,
  runBootGuards,
  worktreeBootRefusal,
} from '../server/bootGuards.js';
import { allowedFrontendOrigins } from '../wsOriginAllowlist.js';

// Regression: an agent that ran `npm run dev` / `node dist/index.js` inside a
// task worktree got through pre-listen startup recovery (task-DB restore,
// snapshot recovery, branch repair, a terminal-server idle-upgrade request)
// against the user's LIVE ~/.lattice before its listen() failed EADDRINUSE.
// These guards now run before any of that.

const home = os.homedir();
const worktree = path.join(home, '.lattice', 'worktrees', 'abc123def456', 'fix-thing-t1');

test('isInsideLatticeWorktree: home-scoped and legacy in-repo worktrees, not their parents', () => {
  assert.equal(isInsideLatticeWorktree(worktree), true);
  assert.equal(isInsideLatticeWorktree(path.join(worktree, 'backend', 'dist', 'server')), true);
  // Legacy <repo>/.lattice/worktrees/<slug> checkouts.
  assert.equal(isInsideLatticeWorktree(path.join('C:\\development\\proj', '.lattice', 'worktrees', 'x-1')), true);
  // Case-insensitive (Windows path spellings).
  assert.equal(isInsideLatticeWorktree(path.join(home, '.Lattice', 'Worktrees', 'h', 'x')), true);
  assert.equal(isInsideLatticeWorktree(path.join(home, '.lattice', 'worktrees')), false);
  assert.equal(isInsideLatticeWorktree(path.join(home, '.lattice', 'logs')), false);
  assert.equal(isInsideLatticeWorktree('C:\\development\\lattice\\backend\\dist\\server'), false);
  assert.equal(isInsideLatticeWorktree(path.join(home, 'worktrees', '.lattice', 'x')), false);
});

test('worktreeBootRefusal: refuses when the code OR the cwd is in a worktree, unless overridden', () => {
  const main = 'C:\\development\\lattice\\backend\\dist\\server';
  assert.equal(worktreeBootRefusal({ codeDir: main, cwd: 'C:\\development\\lattice\\backend', env: {} }), null);

  const fromCode = worktreeBootRefusal({ codeDir: path.join(worktree, 'backend', 'dist', 'server'), cwd: main, env: {} });
  assert.match(fromCode ?? '', /refusing to start: this backend is running from a Lattice task worktree/);
  assert.match(fromCode ?? '', new RegExp(ALLOW_WORKTREE_BACKEND_ENV));

  // The main checkout's dist/index.js launched from a worktree cwd.
  assert.ok(worktreeBootRefusal({ codeDir: main, cwd: worktree, env: {} }));

  assert.equal(
    worktreeBootRefusal({ codeDir: worktree, cwd: worktree, env: { [ALLOW_WORKTREE_BACKEND_ENV]: '1' } }),
    null,
  );
  // Only the exact opt-in value counts.
  assert.ok(worktreeBootRefusal({ codeDir: worktree, cwd: worktree, env: { [ALLOW_WORKTREE_BACKEND_ENV]: 'true' } }));
});

test('probePortBindable: free port binds, a held port reports in-use', async () => {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as AddressInfo;
  try {
    assert.equal(await probePortBindable(port), 'in-use');
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
  // The probe itself must release the port straight away.
  assert.equal(await probePortBindable(port), 'free');
  assert.equal(await probePortBindable(port), 'free');
});

test('identifyListener: a Lattice backend answers /api/health {ok:true}', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url === '/api/health' ? JSON.stringify({ ok: true }) : '{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    assert.equal(await identifyListener(`http://127.0.0.1:${port}`), 'lattice');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Something that is not HTTP / not Lattice.
  const fakeFetch = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
  assert.equal(await identifyListener('http://127.0.0.1:1', fakeFetch), 'other');
});

test('liveBackendRefusal: names a live Lattice backend vs a foreign holder; free/unknown proceed', async () => {
  assert.equal(await liveBackendRefusal(5184, { probe: async () => 'free' }), null);
  // EACCES etc. — the real listen() keeps reporting those as before.
  assert.equal(await liveBackendRefusal(5184, { probe: async () => 'unknown' }), null);

  const lattice = await liveBackendRefusal(5184, {
    probe: async () => 'in-use',
    identify: async (origin) => {
      assert.equal(origin, 'http://127.0.0.1:5184');
      return 'lattice';
    },
  });
  assert.match(lattice ?? '', /another Lattice backend is already serving http:\/\/127\.0\.0\.1:5184/);

  const other = await liveBackendRefusal(5184, { probe: async () => 'in-use', identify: async () => 'other' });
  assert.match(other ?? '', /port 5184 is already in use by another process/);
});

test('runBootGuards: worktree refusal wins before any port probing; live backend refuses', async () => {
  let probed = false;
  await assert.rejects(
    runBootGuards({
      port: 5184, codeDir: worktree, cwd: worktree, env: {},
      liveBackend: async () => { probed = true; return null; },
    }),
    (err: unknown) => err instanceof BootRefusedError && /task worktree/.test(err.message),
  );
  assert.equal(probed, false);

  await assert.rejects(
    runBootGuards({
      port: 5184, codeDir: 'C:\\x\\dist', cwd: 'C:\\x', env: {},
      liveBackend: async () => 'refusing to start: another Lattice backend',
    }),
    BootRefusedError,
  );

  await runBootGuards({ port: 5184, codeDir: 'C:\\x\\dist', cwd: 'C:\\x', env: {}, liveBackend: async () => null });
});

test('allowedFrontendOrigins: 5183 by default, LATTICE_FRONTEND_PORT for an isolated instance', () => {
  assert.deepEqual(allowedFrontendOrigins({}), ['http://localhost:5183', 'http://127.0.0.1:5183']);
  assert.deepEqual(
    allowedFrontendOrigins({ LATTICE_FRONTEND_PORT: '5383' }),
    ['http://localhost:5383', 'http://127.0.0.1:5383'],
  );
});
