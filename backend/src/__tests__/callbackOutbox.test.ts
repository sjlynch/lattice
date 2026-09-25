// The completion-callback outbox: a Stop hook / Pi extension that can't reach
// the backend (restarting after a merge that touched backend/src) must leave
// the callback on disk, and the backend must replay it once it is back.
// These run the REAL generated hook script and Pi extension against a local
// HTTP server, so the byte-significant generated code is exercised, not just
// its shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  callbackOutboxEntryPath,
  claudeCallbackCommand,
  codexCallbackCommands,
  drainCallbackOutbox,
  isReplayableUrl,
  OUTBOX_MAX_AGE_MS,
  renderCallbackScript,
  type OutboxEntry,
} from '../callbackOutbox.js';
import { renderPiCompletionExtension } from '../piExtension.js';

type Hit = { method: string; url: string; body: string };

async function withServer(
  status: number | (() => number),
  fn: (origin: string, hits: Hit[]) => Promise<void>,
): Promise<void> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body });
      res.statusCode = typeof status === 'function' ? status() : status;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, hits);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

// A port nothing listens on: bind one, then close it.
async function deadOrigin(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-outbox-'));
}

async function runScript(script: string, url: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, url], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

async function writeScript(dir: string, outbox: string, budgetMs: number): Promise<string> {
  const file = path.join(dir, 'lattice-callback.cjs');
  await fs.writeFile(file, renderCallbackScript(outbox, { budgetMs, retryDelayMs: 100 }));
  return file;
}

async function readEntry(file: string): Promise<OutboxEntry | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as OutboxEntry;
  } catch {
    return null;
  }
}

test('hook script delivers the callback and leaves no outbox entry', async () => {
  const dir = await tmpDir();
  try {
    const outbox = path.join(dir, 'outbox');
    const script = await writeScript(dir, outbox, 5_000);
    await withServer(200, async (origin, hits) => {
      const url = `${origin}/api/tasks/t1/complete?source=claude-stop-hook-task-complete`;
      assert.equal(await runScript(script, url), 0);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].method, 'POST');
      assert.equal(hits[0].url, '/api/tasks/t1/complete?source=claude-stop-hook-task-complete');
      assert.equal(await readEntry(callbackOutboxEntryPath(url, outbox)), null);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('hook script treats a 404 as final (unknown task) and a 503 as retryable', async () => {
  const dir = await tmpDir();
  try {
    const outbox = path.join(dir, 'outbox');
    const script = await writeScript(dir, outbox, 600);
    await withServer(404, async (origin, hits) => {
      const url = `${origin}/api/tasks/gone/complete`;
      assert.equal(await runScript(script, url), 0);
      assert.equal(hits.length, 1);
      assert.equal(await readEntry(callbackOutboxEntryPath(url, outbox)), null);
    });
    await withServer(503, async (origin, hits) => {
      const url = `${origin}/api/workflow-runs/r1/steps/0/complete`;
      assert.equal(await runScript(script, url), 0);
      assert.ok(hits.length >= 2, `expected retries, saw ${hits.length}`);
      const entry = await readEntry(callbackOutboxEntryPath(url, outbox));
      assert.equal(entry?.url, url);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('hook script leaves the callback in the outbox when the backend is down, and the drain replays it', async () => {
  const dir = await tmpDir();
  try {
    const outbox = path.join(dir, 'outbox');
    const script = await writeScript(dir, outbox, 400);
    const down = await deadOrigin();
    const url = `${down}/api/tasks/t2/complete?source=claude-stop-hook-task-complete`;
    assert.equal(await runScript(script, url), 0, 'a Stop hook must never fail');
    const entry = await readEntry(callbackOutboxEntryPath(url, outbox));
    assert.ok(entry, 'undelivered callback must be kept');
    assert.equal(entry.url, url);
    assert.ok((entry.holdUntil ?? 0) > entry.createdAt);

    // The drain respects the hook's hold window...
    let hits = 0;
    const fetchImpl = (async () => {
      hits++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const held = await drainCallbackOutbox({ backendOrigin: down, dir: outbox, now: () => entry.createdAt + 1, fetchImpl });
    assert.deepEqual(held, { delivered: 0, dropped: 0, kept: 1 });
    assert.equal(hits, 0);

    // ...and replays it once the hook has given up.
    const after = (entry.holdUntil ?? 0) + 1;
    const replayed = await drainCallbackOutbox({ backendOrigin: down, dir: outbox, now: () => after, fetchImpl });
    assert.deepEqual(replayed, { delivered: 1, dropped: 0, kept: 0 });
    assert.equal(hits, 1);
    assert.equal(await readEntry(callbackOutboxEntryPath(url, outbox)), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('drain replays against a real server: 503 keeps with backoff, then delivers', async () => {
  const dir = await tmpDir();
  try {
    let status = 503;
    await withServer(() => status, async (origin, hits) => {
      const url = `${origin}/api/workflow-runs/r1/steps/2/complete?source=claude-stop-hook`;
      const file = callbackOutboxEntryPath(url, dir);
      await fs.writeFile(file, JSON.stringify({ v: 1, url, createdAt: 1_000 }));

      const first = await drainCallbackOutbox({ backendOrigin: origin, dir, now: () => 10_000 });
      assert.deepEqual(first, { delivered: 0, dropped: 0, kept: 1 });
      const kept = await readEntry(file);
      assert.equal(kept?.attempts, 1);
      assert.equal(kept?.lastError, 'HTTP 503');

      // Inside the backoff window: not retried.
      await drainCallbackOutbox({ backendOrigin: origin, dir, now: () => 11_000 });
      assert.equal(hits.length, 1);

      status = 200;
      const later = await drainCallbackOutbox({ backendOrigin: origin, dir, now: () => 60_000 });
      assert.deepEqual(later, { delivered: 1, dropped: 0, kept: 0 });
      assert.equal(hits.length, 2);
      assert.equal(await readEntry(file), null);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('drain forwards a JSON body (Pi prompt-file mode)', async () => {
  const dir = await tmpDir();
  try {
    await withServer(200, async (origin, hits) => {
      const url = `${origin}/api/workflow-prompt-customizations/c1/complete`;
      await fs.writeFile(
        callbackOutboxEntryPath(url, dir),
        JSON.stringify({ v: 1, url, createdAt: 1, body: '{"prompt":"hi"}', contentType: 'application/json' }),
      );
      await drainCallbackOutbox({ backendOrigin: origin, dir, now: () => 5_000 });
      assert.equal(hits[0]?.body, '{"prompt":"hi"}');
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("drain never POSTs outside its own API, leaves other instances' entries, drops stale ones", async () => {
  const dir = await tmpDir();
  try {
    const origin = 'http://127.0.0.1:5184';
    const foreign = 'http://example.com/api/tasks/x/complete';
    const nonApi = `${origin}/ws/tasks`;
    const stale = `${origin}/api/tasks/old/complete`;
    for (const url of [foreign, nonApi]) {
      await fs.writeFile(callbackOutboxEntryPath(url, dir), JSON.stringify({ v: 1, url, createdAt: 1 }));
    }
    await fs.writeFile(callbackOutboxEntryPath(stale, dir), JSON.stringify({ v: 1, url: stale, createdAt: 1 }));
    let hits = 0;
    const res = await drainCallbackOutbox({
      backendOrigin: origin,
      dir,
      now: () => OUTBOX_MAX_AGE_MS + 10,
      fetchImpl: (async () => {
        hits++;
        return new Response('', { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(hits, 0);
    assert.deepEqual(res, { delivered: 0, dropped: 3, kept: 0 });
    assert.deepEqual(await fs.readdir(dir), []);

    // A FRESH entry for another origin (another Lattice instance sharing this
    // home on a different port) is neither sent nor deleted — it's theirs.
    const otherInstance = 'http://127.0.0.1:5384/api/tasks/y/complete';
    await fs.writeFile(callbackOutboxEntryPath(otherInstance, dir), JSON.stringify({ v: 1, url: otherInstance, createdAt: 1 }));
    const fresh = await drainCallbackOutbox({
      backendOrigin: origin,
      dir,
      now: () => 10,
      fetchImpl: (async () => {
        hits++;
        return new Response('', { status: 200 });
      }) as typeof fetch,
    });
    assert.equal(hits, 0);
    assert.deepEqual(fresh, { delivered: 0, dropped: 0, kept: 1 });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.equal(isReplayableUrl('http://127.0.0.1:5184/api/x', 'http://127.0.0.1:5184'), true);
  assert.equal(isReplayableUrl('http://127.0.0.1:5185/api/x', 'http://127.0.0.1:5184'), false);
});

test('hook commands: Claude falls back to a retrying curl; Codex stays shell-free', () => {
  const url = 'http://127.0.0.1:5184/api/tasks/t1/complete?source=claude-stop-hook-task-complete';
  const claude = claudeCallbackCommand(url);
  assert.match(claude, /^node "[^"\\]+lattice-callback\.cjs" "http:\/\/127\.0\.0\.1:5184\/api\/tasks\/t1\/complete\?source=claude-stop-hook-task-complete" \|\| curl /);
  assert.match(claude, /--retry-connrefused/);
  const codex = codexCallbackCommands(url);
  assert.doesNotMatch(codex.posix, /["|]/);
  assert.equal(codex.windows, `cmd /c ${codex.posix}`);
});

test('Pi extension writes the outbox when the backend is down and clears it on delivery', async () => {
  const dir = await tmpDir();
  try {
    const run = async (callbackUrl: string, name: string) => {
      const extensionFile = path.join(dir, `${name}.ts`);
      const sentinelFile = path.join(dir, `${name}.json`);
      const src = renderPiCompletionExtension({
        callbackUrl,
        site: 'workflow-step-complete',
        respectQuitGate: false,
        extensionFile,
        sentinelFile,
      });
      await fs.writeFile(extensionFile, src);
      const mod = (await import(pathToFileURL(extensionFile).href)) as {
        default: (pi: { on: (e: string, h: (ev: unknown) => Promise<void>) => void }) => void;
      };
      let handler: ((ev: unknown) => Promise<void>) | undefined;
      mod.default({ on: (_e, h) => (handler = h) });
      assert.ok(handler);
      await handler({ reason: 'quit' });
      return `${callbackUrl}?source=pi-extension-workflow-step-complete`;
    };

    const down = await deadOrigin();
    const lostUrl = await run(`${down}/api/workflow-runs/r1/steps/0/complete`, 'down');
    const entry = await readEntry(callbackOutboxEntryPath(lostUrl));
    assert.equal(entry?.url, lostUrl);
    assert.equal(entry?.writer, 'pi-extension');

    await withServer(200, async (origin, hits) => {
      const okUrl = await run(`${origin}/api/workflow-runs/r2/steps/0/complete`, 'up');
      assert.equal(hits.length, 1);
      assert.equal(await readEntry(callbackOutboxEntryPath(okUrl)), null);
    });
    await fs.rm(callbackOutboxEntryPath(lostUrl), { force: true });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an answered callback clears its own outbox entry (the hook may be killed by the cleanup it triggered)', async () => {
  const express = (await import('express')).default;
  const { buildCallbackOutboxAck } = await import('../callbackOutbox/ack.js');
  const dir = await tmpDir();
  try {
    const app = express();
    let origin = '';
    app.use((req, res, next) => buildCallbackOutboxAck(origin, dir)(req, res, next));
    app.post('/api/push-runs/:id/done', (_req, res) => res.json({ ok: true }));
    app.post('/api/tasks/:id/complete', (_req, res) => res.status(503).json({}));
    app.post('/api/tasks/:id/activity', (_req, res) => res.status(204).end());
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const done = `${origin}/api/push-runs/p1/done?source=claude-stop-hook`;
      const failing = `${origin}/api/tasks/t1/complete?source=claude-stop-hook-task-complete`;
      const activity = `${origin}/api/tasks/t1/activity`;
      for (const url of [done, failing, activity]) {
        await fs.writeFile(callbackOutboxEntryPath(url, dir), JSON.stringify({ v: 1, url, createdAt: Date.now() }));
        await fetch(url, { method: 'POST' });
      }
      // The unlink runs on 'finish'; give it a tick.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await readEntry(callbackOutboxEntryPath(done, dir)), null, 'answered → cleared');
      assert.ok(await readEntry(callbackOutboxEntryPath(failing, dir)), '5xx → kept for retry');
      assert.ok(await readEntry(callbackOutboxEntryPath(activity, dir)), 'not a completion route → untouched');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
