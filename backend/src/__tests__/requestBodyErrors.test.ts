import assert from 'node:assert/strict';
import http from 'node:http';
import { inspect } from 'node:util';
import { test } from 'node:test';
import express, { type Express, type ErrorRequestHandler } from 'express';
import { mountBaseMiddleware, mountJsonErrorMiddleware } from '../server/app.js';
import { buildTaskCrudRouter } from '../routes/tasks/crud.js';
import { createTask, getTask } from '../tasks.js';
import { withTempDir } from './helpers/tempDir.js';

async function withApp(app: Express, run: (url: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run('http://127.0.0.1:' + address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('malformed summary JSON is a nonfatal 400, changes no task, and never dumps the body', async (t) => {
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  await withTempDir('lattice-summary-json-', async (project) => {
    const task = await createTask(project, 'request parser fixture', 'original ticket');
    const app = express();
    mountBaseMiddleware(app);
    app.use(buildTaskCrudRouter());
    app.get('/health-fixture', (_req, res) => { res.json({ ok: true }); });
    mountJsonErrorMiddleware(app);
    // Matches the old instruction's hand-built JSON with a Windows path.
    // No real user's summary or credentials are used by this fixture.
    const badJson = '{"summary":"PRIVATE_FIXTURE Changed C:\\development\\lattice\\file.ts"}';
    assert.throws(() => JSON.parse(badJson), SyntaxError);
    await withApp(app, async (base) => {
      const url = base + '/api/tasks/' + task.id + '/append-summary';
      const response = await fetch(url + '?private=QUERY_FIXTURE', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: badJson,
      });
      assert.equal(response.status, 400);
      const body = await response.json() as { error: string; code: string };
      assert.equal(body.code, 'entity.parse.failed');
      assert.match(body.error, /serializer/);
      assert.equal((await getTask(task.id))?.summary, undefined);
      assert.equal((await getTask(task.id))?.description, 'original ticket');
      assert.equal(errors.length, 0, 'a rejected body is not logged as a server failure');
      assert.equal(warnings.length, 1);
      const logged = inspect(warnings);
      assert.match(logged, /entity\.parse\.failed/);
      assert.match(logged, /append-summary/);
      assert.doesNotMatch(logged + JSON.stringify(body), /PRIVATE_FIXTURE|QUERY_FIXTURE/);
      const health = await fetch(base + '/health-fixture');
      assert.equal(health.status, 200, 'the same server continues accepting requests');
      assert.deepEqual(await health.json(), { ok: true });
    });
  });
});

test('markdown and serialized JSON summaries preserve Windows paths, quotes, and literal escapes', async () => {
  await withTempDir('lattice-summary-transport-', async (project) => {
    const app = express();
    mountBaseMiddleware(app);
    app.use(buildTaskCrudRouter());
    mountJsonErrorMiddleware(app);
    const summary = [
      'Windows C:\\development\\lattice\\file.ts',
      'Quotes "double" and \'single\', Unicode café 🧪',
      'Literal escapes: \\n \\t \\(pattern\\) and \\u1234',
      'Actual newlines\nare preserved.',
    ].join('\n');
    await withApp(app, async (base) => {
      for (const contentType of ['text/markdown; charset=utf-8', 'application/json']) {
        const task = await createTask(project, 'transport fixture', 'keep ticket');
        const response = await fetch(base + '/api/tasks/' + task.id + '/append-summary', {
          method: 'POST', headers: { 'Content-Type': contentType },
          body: contentType.startsWith('text/') ? summary : JSON.stringify({ summary }),
        });
        assert.equal(response.status, 200);
        await response.json();
        const saved = await getTask(task.id);
        assert.equal(saved?.summary, summary);
        assert.equal(saved?.description, 'keep ticket');
      }
    });
  });
});

test('body-parser size and charset failures keep 413/415 without invoking the route', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const app = express();
  app.use(express.json({ limit: 32 }));
  let handled = 0;
  app.post('/payload', (_req, res) => { handled++; res.json({ ok: true }); });
  mountJsonErrorMiddleware(app);
  await withApp(app, async (base) => {
    const oversized = await fetch(base + '/payload', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'x'.repeat(64) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { code: string }).code, 'entity.too.large');
    const charset = await fetch(base + '/payload', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=iso-8859-1' }, body: '{}',
    });
    assert.equal(charset.status, 415);
    assert.equal((await charset.json() as { code: string }).code, 'charset.unsupported');
    assert.equal(handled, 0);
  });
});

test('unexpected route exceptions still log and return JSON 500', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const app = express();
  const failure = new SyntaxError('internal state decode failed');
  app.get('/failure', async () => { throw failure; });
  mountJsonErrorMiddleware(app);
  await withApp(app, async (base) => {
    const response = await fetch(base + '/failure');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: failure.message });
    assert.equal(errors[0]?.[1], failure);
  });
});

test('an error after headers were sent delegates without attempting a second response', async (t) => {
  t.mock.method(console, 'error', () => {});
  const app = express();
  const failure = new Error('stream failed');
  let delegated: unknown;
  app.get('/stream', (_req, res, next) => {
    res.write('partial');
    next(failure);
  });
  mountJsonErrorMiddleware(app);
  const finish: ErrorRequestHandler = (err, _req, res, _next) => {
    delegated = err;
    res.end(' finished');
  };
  app.use(finish);
  await withApp(app, async (base) => {
    const response = await fetch(base + '/stream');
    assert.equal(await response.text(), 'partial finished');
    assert.equal(delegated, failure);
  });
});

// Regression: Express's own client errors carry a 4xx `status` — a malformed
// percent-escape in a `:param` throws "Failed to decode param" with status 400
// — but the JSON error middleware answered every non-body error with a 500 and
// logged it as a server failure.
test('an Express client error (undecodable :param) keeps its 400 and is not logged as a failure', async (t) => {
  const errors: unknown[][] = [];
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  const app = express();
  let handled = 0;
  app.get('/api/things/:id', (_req, res) => { handled++; res.json({ ok: true }); });
  app.get('/secret', (_req, _res, next) => {
    next(Object.assign(new Error('internal detail'), { status: 403, expose: false }));
  });
  mountJsonErrorMiddleware(app);
  await withApp(app, async (base) => {
    const response = await fetch(base + '/api/things/%E0%A4%A');
    assert.equal(response.status, 400);
    assert.match((await response.json() as { error: string }).error, /decode param/);
    assert.equal(handled, 0);
    assert.equal(errors.length, 0);
    // An error that says it is not safe to show stays an opaque 500.
    const hidden = await fetch(base + '/secret');
    assert.equal(hidden.status, 500);
  });
});
