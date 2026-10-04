// installPiCompletionExtension writes the extension via temp + rename (a torn
// file would be a Pi session with no completion backstop) and leaves no temp
// behind — Pi auto-loads every `.ts` under `.pi/extensions/`, so the directory
// must hold exactly the extension after an install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { withTempDir } from './helpers/tempDir.js';
import { installPiCompletionExtension, renderPiCompletionExtension } from '../piExtension.js';

test('interactive Pi reviews report each settled main turn while default shutdown bytes stay unchanged', async () => withTempDir('lattice-piext-turn-', async (dir) => {
  let posts = 0;
  const server = createServer((_req, res) => { posts++; res.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const opts = { dir, callbackUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/opengrep/reviews/sreview_100_ab/done`,
      site: 'security-review-done' as const, respectQuitGate: false, eventName: 'agent_settled' as const };
    const installed = await installPiCompletionExtension(opts);
    const common = { ...opts, ...installed };
    assert.equal(renderPiCompletionExtension({ ...common, eventName: undefined }),
      renderPiCompletionExtension({ ...common, eventName: 'session_shutdown' }));
    const mod = await import(pathToFileURL(installed.extensionFile).href) as {
      default: (pi: { on: (event: string, handler: (event: unknown, ctx?: unknown) => Promise<void>) => void }) => void;
    };
    const handlers = new Map<string, (event: unknown, ctx?: unknown) => Promise<void>>();
    mod.default({ on: (event, handler) => { handlers.set(event, handler); } });
    assert.deepEqual([...handlers.keys()], ['agent_settled']);
    const settle = handlers.get('agent_settled')!;
    await settle({}, { sessionManager: { getSessionFile: () => undefined } });
    assert.equal(posts, 0, 'a subagent cannot mark the main conversation waiting');
    const main = { sessionManager: { getSessionFile: () => 'conversation.jsonl' } };
    await settle({}, main);
    await settle({}, main);
    assert.equal(posts, 2, 'report subsequent conversational turns without quitting Pi');
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}));

test('installPiCompletionExtension writes the rendered extension and leaves no temp file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-piext-'));
  try {
    const args = {
      dir,
      callbackUrl: 'http://127.0.0.1:5184/api/tasks/t1/complete',
      site: 'task-complete' as const,
      respectQuitGate: true,
    };
    const { extensionFile, sentinelFile } = await installPiCompletionExtension(args);
    const written = await fs.readFile(extensionFile, 'utf8');
    assert.equal(
      written,
      renderPiCompletionExtension({ ...args, extensionFile, sentinelFile }),
    );
    // Idempotent re-install.
    await installPiCompletionExtension(args);
    const names = await fs.readdir(path.dirname(extensionFile));
    assert.deepEqual(names, [path.basename(extensionFile)]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
