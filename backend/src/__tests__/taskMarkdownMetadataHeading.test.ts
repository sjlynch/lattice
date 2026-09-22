import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { parseMarkdownDoc } from '../routes/tasks/markdownBatch.js';
import { taskPatchFromBody } from '../routes/tasks/crudUpdateBody.js';
import { validateUpsertBlocks } from '../routes/tasks/crudUpdateValidation.js';

// A metadata-only heading (`# {id=t_1, status=done}`) used to fail the
// optional-metadata branch of HEADING_RE (the title was required), so the
// whole `{…}` text became the TITLE: an upsert created a junk task named
// "{id=t_1, status=done}" instead of moving t_1, and a markdown PATCH renamed
// the task to it. With trailing whitespace it parsed the metadata but produced
// an EMPTY title that PATCH then persisted.

test('parseMarkdownDoc: a metadata-only heading parses its metadata with an empty title', () => {
  for (const md of ['# {id=t_1, status=done}', '# {id=t_1, status=done}   ', '# {id=t_1 status=done}\nbody']) {
    const [block] = parseMarkdownDoc(md).tasks;
    assert.equal(block.id, 't_1', md);
    assert.equal(block.status, 'done', md);
    assert.equal(block.title, '', md);
  }
  // A bare `#` line with neither metadata nor a title is still body text.
  assert.deepEqual(parseMarkdownDoc('#   \nx').tasks, []);
  assert.deepEqual(parseMarkdownDoc('# T\n#   \nx').tasks, [{ title: 'T', description: '#   \nx' }]);
});

test('parseMarkdownDoc singleTask: later level-1 headings are description, not new tasks', () => {
  const md = '# Title\npara\n# Section\nmore';
  assert.equal(parseMarkdownDoc(md).tasks.length, 2);
  assert.deepEqual(parseMarkdownDoc(md, { singleTask: true }).tasks, [
    { title: 'Title', description: 'para\n# Section\nmore' },
  ]);
});

test('taskPatchFromBody (markdown): status-only heading never renames or blanks the title', () => {
  assert.deepEqual(taskPatchFromBody('# {status=qa}'), { ok: true, value: { status: 'qa' } });
  assert.deepEqual(taskPatchFromBody('# {status=qa}   \nnew body'), {
    ok: true,
    value: { status: 'qa', description: 'new body' },
  });
  // Every line after the first heading survives into the description.
  assert.deepEqual(taskPatchFromBody('# New\nintro\n# Details\nkept'), {
    ok: true,
    value: { title: 'New', description: 'intro\n# Details\nkept' },
  });
});

test('validateUpsertBlocks: an id-bearing block may omit its title; a create may not', () => {
  assert.equal(validateUpsertBlocks([{ id: 't_1', title: '', status: 'done' }]), null);
  assert.equal(validateUpsertBlocks([{ id: 't_1' } as never]), null);
  assert.match(String(validateUpsertBlocks([{ title: '' }])), /tasks\[0\]\.title is required/);
  assert.match(String(validateUpsertBlocks([{ id: 5, title: 'x' } as never])), /tasks\[0\]\.id must be a string/);
  assert.match(String(validateUpsertBlocks([{ id: 't_1', title: 7 } as never])), /tasks\[0\]\.title must be a string/);
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

test('routes: status-only upsert/PATCH move the task and keep its title; transition refuses non-string ids', async () => {
  const tmpHome = await mkdtemp(path.join(os.tmpdir(), 'lattice-md-meta-heading-'));
  const originalEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const project = path.join(tmpHome, 'project');
  await mkdir(path.join(project, '.git'), { recursive: true });

  let server: http.Server | null = null;
  try {
    const { createBackendApp } = await import('../server/app.js');
    const { flushPersist, listTasks } = await import('../tasks.js');
    const app = createBackendApp({ defaultRoot: project, backendOrigin: 'http://127.0.0.1:5184' });
    server = http.createServer(app);
    const base = `http://127.0.0.1:${await listen(server)}`;
    const q = `project=${encodeURIComponent(project)}`;
    const md = { 'Content-Type': 'text/markdown' };

    const created = (await (await fetch(`${base}/api/tasks?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Keep me', description: 'original' }),
    })).json()) as { id: string };

    const upsert = await fetch(`${base}/api/tasks/upsert?${q}`, {
      method: 'POST',
      headers: md,
      body: `# {id=${created.id}, status=qa}\n`,
    });
    assert.equal(upsert.status, 200);
    const upserted = (await upsert.json()) as { created: number; updated: number };
    assert.equal(upserted.created, 0, 'no junk task created from the metadata text');
    assert.equal(upserted.updated, 1);

    const patch = await fetch(`${base}/api/tasks/${created.id}`, {
      method: 'PATCH',
      headers: md,
      body: '# {status=backlog}   \n',
    });
    assert.equal(patch.status, 200);

    const tasks = await listTasks(project);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'Keep me');
    assert.equal(tasks[0].status, 'backlog');
    assert.equal(tasks[0].description, 'original');

    const transition = await fetch(`${base}/api/tasks/transition?${q}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [created.id, 42], status: 'done' }),
    });
    assert.equal(transition.status, 400);
    assert.match(((await transition.json()) as { error: string }).error, /ids\[1\] must be a non-empty string/);
    assert.equal((await listTasks(project))[0].status, 'backlog', 'a rejected transition writes nothing');

    await flushPersist(project);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (originalEnv.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originalEnv.HOME;
    if (originalEnv.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalEnv.USERPROFILE;
    await rm(tmpHome, { recursive: true, force: true });
  }
});
