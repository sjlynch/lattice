import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMergeRun, subscribe, type MergeRun } from '../mergeRuns.js';
import type { Task } from '../tasks.js';

test('an unexpected target failure restores the run snapshot before reporting the run errored', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-run-failure-'));
  const repo = path.join(root, 'repo');
  const snapshot = path.join(root, 'snapshot');
  await fs.mkdir(repo);
  await fs.mkdir(snapshot);
  await fs.writeFile(path.join(repo, 'work.ts'), 'clean HEAD');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('add', '--', 'work.ts');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base');
  await fs.writeFile(path.join(snapshot, 'work.ts'), 'uncommitted user work');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let completed!: (run: MergeRun) => void;
  const completion = new Promise<MergeRun>((resolve) => { completed = resolve; });
  const unsub = subscribe((event) => {
    if (event.type === 'completed' && event.run.projectPath === repo) completed(event.run);
  });
  t.after(unsub);
  const task = { id: 'failing-task', projectPath: repo, title: 'task', status: 'ready_to_merge', createdAt: 1 } as Task;
  await startMergeRun(repo, 'http://unused', {}, {
    listTasks: async () => [task],
    runPreflight: async () => ({ runSnapshot: { dir: snapshot, modifiedTracked: ['work.ts'], untracked: [] }, baselineHead: null }),
    processTarget: async () => { throw new Error('injected target read failure'); },
  });
  const finished = await completion;
  assert.equal(finished.status, 'errored');
  assert.match(finished.errored[0].error, /injected target read failure/);
  assert.equal(await fs.readFile(path.join(repo, 'work.ts'), 'utf8'), 'uncommitted user work');
  await assert.rejects(fs.access(snapshot), { code: 'ENOENT' });
});
