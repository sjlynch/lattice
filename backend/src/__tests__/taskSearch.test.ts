import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { mountBaseMiddleware } from '../server/app.js';
import { buildTaskCrudRouter } from '../routes/tasks/crud.js';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SNIPPET_CHARS,
  buildSearchEnvelope,
  buildSnippet,
  parseSearchQuery,
  searchTasks,
  type SearchQuery,
} from '../routes/tasks/taskSearch.js';
import type { ListEnvelopeMeta } from '../routes/tasks/listQuery.js';
import type { Task } from '../tasks.js';

// The find tier of the task API. "Which task was the one about X" is the
// question that used to drag an agent into GETting the whole 1 MB board, so
// this has to answer it in ~1 KB and — unlike the list — has to look at EVERY
// lane by default, since the interesting matches are usually in history.
// Pure functions only: no Express, no task store.

const PROJECT = 'C:\\development\\lattice';
const META: ListEnvelopeMeta = {
  project: PROJECT,
  canonicalProject: PROJECT,
  hash: 'abc123def456',
  mismatched: 0,
};

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    projectPath: PROJECT,
    title: `task ${id}`,
    status: 'open',
    createdAt: 1_000,
    ...over,
  };
}

function parse(raw: Record<string, string | undefined>): SearchQuery {
  const parsed = parseSearchQuery(raw);
  assert.ok(parsed.ok, `expected parse to succeed: ${parsed.ok ? '' : parsed.error}`);
  return parsed.value;
}

function search(tasks: Task[], raw: Record<string, string | undefined>) {
  return searchTasks(tasks, parse(raw));
}

// ---------------------------------------------------------------- parsing --

test('q is required', () => {
  for (const raw of [{}, { q: '' }, { q: '   ' }]) {
    const parsed = parseSearchQuery(raw);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok ? '' : parsed.error, 'q required');
  }
});

test('limit defaults to 20 and caps at 200', () => {
  assert.equal(parse({ q: 'x' }).limit, DEFAULT_SEARCH_LIMIT);
  assert.equal(parse({ q: 'x', limit: '5' }).limit, 5);
  assert.equal(parse({ q: 'x', limit: '9999' }).limit, MAX_SEARCH_LIMIT);
  assert.equal(parse({ q: 'x', limit: '0' }).limit, MAX_SEARCH_LIMIT);
  const bad = parseSearchQuery({ q: 'x', limit: 'lots' });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /limit must be a non-negative integer/);
});

test('q is split into lowercased terms', () => {
  assert.deepEqual(parse({ q: '  Merge   RUN ' }).terms, ['merge', 'run']);
});

// --------------------------------------------------------------- matching --

test('every term must occur somewhere in the task (AND semantics)', () => {
  const tasks = [
    task('both', { title: 'merge run', description: 'x' }),
    task('one', { title: 'merge only' }),
    task('split', { title: 'merge', summary: 'the run finished' }),
  ];
  // Terms may land in different fields — the AND is over the whole record.
  assert.deepEqual(
    search(tasks, { q: 'merge run' }).results.map((r) => r.id).sort(),
    ['both', 'split'],
  );
});

test('matching is case-insensitive and substring-based', () => {
  const tasks = [task('a', { title: 'Refactor The MergeRunner' })];
  assert.equal(search(tasks, { q: 'mergerun' }).results.length, 1);
  assert.equal(search(tasks, { q: 'MERGERUN' }).results.length, 1);
  // Substring, not word — `merge` and `runner` both hit inside `MergeRunner`.
  assert.equal(search(tasks, { q: 'merge runner' }).results.length, 1);
  assert.equal(search(tasks, { q: 'merge absent' }).results.length, 0);
});

test('search covers every lane by default, including done history', () => {
  const tasks = [
    task('done', { status: 'done', title: 'widget cleanup' }),
    task('open', { status: 'open', title: 'widget rewrite' }),
  ];
  assert.equal(search(tasks, { q: 'widget' }).matched, 2);
  // …and an explicit status still narrows it, same CSV grammar as the list.
  assert.deepEqual(search(tasks, { q: 'widget', status: 'open' }).results.map((r) => r.id), ['open']);
  assert.equal(search(tasks, { q: 'widget', status: 'all' }).matched, 2);
});

// ---------------------------------------------------------------- scoring --

test('a title hit is worth three body hits, and occurrences accumulate', () => {
  const tasks = [
    task('title2', { title: 'widget widget', description: '' }),
    task('body3', { title: 'unrelated', description: 'widget widget widget' }),
    task('body1', { title: 'unrelated', summary: 'widget' }),
  ];
  const { results } = search(tasks, { q: 'widget' });
  assert.deepEqual(
    results.map((r) => [r.id, r.score]),
    [
      ['title2', 6],
      ['body3', 3],
      ['body1', 1],
    ],
  );
});

test('scores sum across terms and ties break toward the newest task', () => {
  const tasks = [
    task('older', { title: 'merge run', createdAt: 10 }),
    task('newer', { title: 'merge run', createdAt: 10, updatedAt: 500 }),
  ];
  const { results } = search(tasks, { q: 'merge run' });
  assert.deepEqual(results.map((r) => r.id), ['newer', 'older']);
  assert.equal(results[0].score, 6, '3 for each term in the title');
  assert.equal(results[0].lastActivityAt, 500);
});

test('a result item carries only the scan fields', () => {
  const tasks = [task('a', { status: 'qa', description: 'the widget', createdAt: 7 })];
  const [only] = search(tasks, { q: 'widget' }).results;
  assert.deepEqual(Object.keys(only).sort(), [
    'id',
    'lastActivityAt',
    'score',
    'snippet',
    'status',
    'title',
  ]);
  assert.equal(only.status, 'qa');
  assert.equal(only.lastActivityAt, 7);
});

// --------------------------------------------------------------- snippets --

test('a snippet is a window around the first hit, ellipsed at each cut end', () => {
  const description = `${'a'.repeat(300)}NEEDLE${'b'.repeat(700)}`;
  const [only] = search([task('a', { description })], { q: 'needle' }).results;
  assert.ok(only.snippet.startsWith('…'), only.snippet.slice(0, 20));
  assert.ok(only.snippet.endsWith('…'));
  assert.ok(only.snippet.includes('NEEDLE'));
  assert.equal(only.snippet.length, SNIPPET_CHARS + 2, 'window plus one ellipsis per end');
});

test('a short description is returned whole, with no ellipses', () => {
  const [only] = search([task('a', { description: 'find the widget here' })], {
    q: 'widget',
  }).results;
  assert.equal(only.snippet, 'find the widget here');
});

test('the snippet falls back to the summary when the hit is only there', () => {
  const tasks = [task('a', { description: 'unrelated body', summary: 'the widget landed' })];
  const [only] = search(tasks, { q: 'widget' }).results;
  assert.equal(only.snippet, 'the widget landed');
});

test('a title-only hit gets an empty snippet', () => {
  // The title is already in the result item; repeating it as a snippet would
  // be pure payload with no information.
  const tasks = [task('a', { title: 'Widget refactor', description: 'nothing relevant' })];
  const [only] = search(tasks, { q: 'widget' }).results;
  assert.equal(only.snippet, '');
});

test('snippet whitespace is collapsed so a multi-line body stays one line', () => {
  const snippet = buildSnippet('intro\n\n   the widget   \n\ntail', ['widget']);
  assert.equal(snippet, 'intro the widget tail');
});

test('buildSnippet returns empty for text with no hit', () => {
  assert.equal(buildSnippet('nothing here', ['widget']), '');
  assert.equal(buildSnippet('', ['widget']), '');
});

// -------------------------------------------------------------- envelope --

test('limit cuts the result set and the envelope says so', () => {
  const tasks = Array.from({ length: 5 }, (_, i) =>
    task(`t${i}`, { title: 'widget', createdAt: i }),
  );
  const query = parse({ q: 'widget', limit: '2' });
  const selection = searchTasks(tasks, query);
  assert.equal(selection.results.length, 2);
  assert.equal(selection.matched, 5);
  assert.equal(selection.truncated, true);

  const envelope = buildSearchEnvelope(META, query, selection);
  assert.equal(envelope.q, 'widget');
  assert.equal(envelope.count, 2);
  assert.equal(envelope.matched, 5);
  assert.equal(envelope.truncated, true);
  assert.equal(envelope.hint, 'Showing 2 of 5 matches — raise limit= (max 200) or add more terms.');
  assert.equal(envelope.canonicalProject, PROJECT);
  assert.equal(envelope.hash, META.hash);
});

test('an untruncated envelope carries no hint and prices itself', () => {
  const query = parse({ q: 'widget' });
  const envelope = buildSearchEnvelope(
    META,
    query,
    searchTasks([task('a', { title: 'widget' })], query),
  );
  assert.equal(envelope.hint, undefined);
  assert.ok(envelope.bytes > 0);
  assert.equal(envelope.approxTokens, Math.ceil(envelope.bytes / 4));
});

test('no matches is an empty envelope, not an error', () => {
  const query = parse({ q: 'nothing-like-this' });
  const envelope = buildSearchEnvelope(META, query, searchTasks([task('a')], query));
  assert.equal(envelope.count, 0);
  assert.equal(envelope.matched, 0);
  assert.equal(envelope.truncated, false);
  assert.deepEqual(envelope.results, []);
});

// ------------------------------------------------------------ route order --

async function withCrudRouter<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const app = express();
  mountBaseMiddleware(app);
  app.use(buildTaskCrudRouter());
  const server: Server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /api/tasks/search is registered ahead of /api/tasks/:id', async () => {
  // The whole failure mode this guards: `/api/tasks/:id` matches the literal
  // path `/api/tasks/search`, so a mis-ordered registration turns every search
  // into a 404 "not found" for a task whose id is "search". A `q`-less request
  // reaching the search handler answers `q required` — which only the correct
  // ordering can produce.
  await withCrudRouter(async (baseUrl) => {
    const project = encodeURIComponent(PROJECT);
    const missingQ = await fetch(`${baseUrl}/api/tasks/search?project=${project}`);
    assert.equal(missingQ.status, 400);
    assert.deepEqual(await missingQ.json(), { error: 'q required' });

    const ok = await fetch(`${baseUrl}/api/tasks/search?project=${project}&q=widget`);
    assert.equal(ok.status, 200);
    const envelope = (await ok.json()) as { q: string; results: unknown[]; bytes: number };
    assert.equal(envelope.q, 'widget');
    assert.ok(Array.isArray(envelope.results));
    assert.ok(envelope.bytes > 0);
  });
});
