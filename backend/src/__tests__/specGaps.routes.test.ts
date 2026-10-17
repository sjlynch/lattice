// The settings/API boundary validates before writing and exposes only the chosen
// project's recent reports. Exercise real routers on an ephemeral test port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { buildSettingsRouter } from '../routes/settings.js';
import { createTask, updateTask, flushPersist } from '../tasks.js';
import { getUserSettings, plannerSpecGapsIn } from '../userSettings.js';
import { withTempDir } from './helpers/tempDir.js';

async function withApi(fn: (base: string, project: string) => Promise<void>) {
  await withTempDir('lattice-spec-gaps-', async (project) => {
    const app = express();
    app.use(express.json());
    app.use(buildSettingsRouter());
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, project);
    } finally {
      await flushPersist(project);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

test('PATCH task-writing settings: all validation messages, cleaning and removal', async () => {
  await withApi(async (base, project) => {
    const url = `${base}/api/settings?project=${encodeURIComponent(project)}`;
    const patch = (body: unknown) => fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const cases: [unknown, string][] = [
      [{ taskWritingRules: 'text' }, 'taskWritingRules must be an array of strings'],
      [{ taskWritingRules: ['ok', 1] }, 'taskWritingRules must be an array of strings'],
      [{ taskWritingRules: null }, 'taskWritingRules must be an array of strings'],
      [{ taskWritingRules: Array.from({ length: 13 }, (_, i) => `r${i}`) }, 'taskWritingRules allows at most 12 rules'],
      [{ taskWritingRules: ['x'.repeat(301)] }, 'each task-writing rule must be at most 300 characters'],
      ...['false', 1, null, []].map((plannerSpecGaps): [unknown, string] => [{ plannerSpecGaps }, 'plannerSpecGaps must be a boolean']),
    ];
    for (const [body, error] of cases) {
      const response = await patch(body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error });
    }
    await assert.rejects(fs.access(path.join(project, '.lattice', 'userSettings.json')));
    const response = await patch({ taskWritingRules: [' one ', '', 'one', 'Two', 'two', '  ', ...Array(15).fill('one')], plannerSpecGaps: false, sidebarWidth: 321 });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).taskWritingRules, ['one', 'Two', 'two']);
    assert.equal(plannerSpecGapsIn(await getUserSettings(project)), false);
    assert.equal((await patch({ taskWritingRules: ['x'.repeat(300)] })).status, 200);
    const cleared = await patch({ taskWritingRules: [' ', ''], plannerSpecGaps: true });
    assert.equal(cleared.status, 200);
    const settings = await cleared.json();
    assert.equal('taskWritingRules' in settings, false);
    assert.equal('plannerSpecGaps' in settings, false);
    assert.equal(settings.sidebarWidth, 321);
    const disk = JSON.parse(await fs.readFile(path.join(project, '.lattice', 'userSettings.json'), 'utf8'));
    assert.equal('taskWritingRules' in disk, false);
    assert.equal('plannerSpecGaps' in disk, false);
    assert.equal(plannerSpecGapsIn(disk), true);
    assert.equal((await patch({ taskWritingRules: [] })).status, 200);
  });
});

test('GET spec-gaps: project guard, limit validation, default 25 and project isolation', async () => {
  await withApi(async (base, project) => {
    for (const query of ['', '?project=relative', '?project=C%3Adrive-relative']) {
      const response = await fetch(`${base}/api/spec-gaps${query}`);
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /project|absolute/i);
    }
    const url = `${base}/api/spec-gaps?project=${encodeURIComponent(project)}`;
    for (const limit of ['0', '-1', '101', '1.5', 'NaN', 'abc', '', '2&limit=3']) {
      const response = await fetch(`${url}&limit=${limit}`);
      assert.equal(response.status, 400, limit);
      assert.deepEqual(await response.json(), { error: 'limit must be an integer from 1 to 100' });
    }
    assert.deepEqual(await (await fetch(url)).json(), { gaps: [] });
    const task = await createTask(project, 'Local task');
    await updateTask(task.id, { summary: 'Spec gaps:\n' + Array.from({ length: 30 }, (_, i) => `- gap ${i}`).join('\n') });
    await withTempDir('lattice-other-gaps-', async (other) => {
      const foreign = await createTask(other, 'Foreign task');
      await updateTask(foreign.id, { summary: 'Spec gaps: foreign gap' });
      await flushPersist(other);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const { gaps } = await response.json();
      assert.equal(gaps.length, 25);
      assert.ok(gaps.every((gap: { taskId: string }) => gap.taskId === task.id));
      assert.equal((await (await fetch(`${url}&limit=1`)).json()).gaps.length, 1);
      assert.equal((await (await fetch(`${url}&limit=100`)).json()).gaps.length, 30);
    });
  });
});
