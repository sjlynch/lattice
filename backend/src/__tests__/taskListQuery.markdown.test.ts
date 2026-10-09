// GET /api/tasks?format=markdown (fixtures: helpers/taskListQuery.ts). The doc
// round-trips through /upsert (which REPLACES descriptions), so it never clips;
// it records the filter actually applied, and a listing capped by limit says so
// in-band (it used to carry nothing, so an agent triaged / re-upserted a
// 250-task lane's newest 100 believing it had it all). Because it never clips,
// the response ceiling (413) applies to it too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIST_LIMIT, buildListOutcome } from '../routes/tasks/listQuery.js';
import { parseMarkdownDoc } from '../routes/tasks/markdownBatch.js';
import { META, parse, task } from './helpers/taskListQuery.js';

// --------------------------------------------------------------- markdown --

test('format=markdown never clips and records the filter actually applied', () => {
  const outcome = buildListOutcome(
    META,
    [task('a', { description: 'd'.repeat(900) }), task('c', { status: 'done' })],
    parse({ format: 'markdown' }),
  );
  assert.equal(outcome.kind, 'markdown');
  const md = (outcome as { markdown: string }).markdown;
  // Clipping a doc that round-trips through /upsert (which REPLACES
  // descriptions) would silently destroy task text on the way back.
  assert.ok(md.includes('d'.repeat(900)));
  assert.ok(!md.includes('…'));
  assert.match(md, /status=backlog,open,in_progress,ready_to_merge,qa/);
  assert.ok(!md.includes('# {id=c'), 'the default lane filter still applies');
});

test('a markdown listing capped by limit says so in-band and still parses to exactly the page', () => {
  // The JSON envelope carries `truncated`; the markdown doc used to carry
  // nothing, so a 250-task lane came back as its newest 100 with no sign the
  // rest existed — and an agent triaged / re-upserted believing it had it all.
  const tasks = Array.from({ length: 150 }, (_, i) =>
    task(`t${i}`, { status: 'backlog', createdAt: 1_000 + i, description: `d${i}\n\n# Plan\nstep` }),
  );
  const outcome = buildListOutcome(META, tasks, parse({ status: 'backlog', format: 'markdown' }));
  assert.equal(outcome.kind, 'markdown');
  const md = (outcome as { markdown: string }).markdown;
  assert.match(md, new RegExp(`truncated=${DEFAULT_LIST_LIMIT}/150`));
  assert.match(md, new RegExp(`showing ${DEFAULT_LIST_LIMIT} of 150`));
  const doc = parseMarkdownDoc(md);
  assert.equal(doc.tasks.length, DEFAULT_LIST_LIMIT, 'no extra tasks from the marker or the # Plan lines');
  for (const t of doc.tasks) {
    assert.ok(t.id);
    assert.match(t.description ?? '', /^d\d+\n\n# Plan\nstep$/);
  }

  const all = buildListOutcome(META, tasks, parse({ status: 'backlog', format: 'markdown', limit: '0' }));
  const allMd = (all as { markdown: string }).markdown;
  assert.ok(!allMd.includes('truncated='), 'an uncapped listing carries no marker');
  assert.equal(parseMarkdownDoc(allMd).tasks.length, 150);
});

test('a markdown response over the ceiling is a 413 too', () => {
  // `format=markdown` never clips, so a big lane is exactly where the ceiling
  // earns its keep — a 413 body must not be what lands in the agent's .md file
  // (the recipe uses curl --fail for that reason).
  const tasks = Array.from({ length: 300 }, (_, i) =>
    task(`t${i}`, { status: 'open', description: 'x'.repeat(1000) }),
  );
  const outcome = buildListOutcome(META, tasks, parse({ format: 'markdown', limit: '0' }));
  assert.equal(outcome.kind, 'too-large');
  const ok = buildListOutcome(META, tasks, parse({ format: 'markdown', limit: '0', confirm_large: '1' }));
  assert.equal(ok.kind, 'markdown');
});
