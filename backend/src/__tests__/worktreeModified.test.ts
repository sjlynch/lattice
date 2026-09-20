import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Task } from '../tasks.js';
import { canonicalProjectPath } from '../projectPath.js';
import {
  parseNulPaths,
  parsePorcelainPaths,
} from '../routes/tasks/worktreeModifiedParsers.js';
import { createWorktreeModifiedService } from '../routes/tasks/worktreeModifiedService.js';
import {
  createBaseBranchResolver,
  modifiedFilesForTask,
} from '../routes/tasks/worktreeModifiedGit.js';
import { DEFAULT_BASE_BRANCH } from '../routes/tasks/worktreeModifiedConstants.js';
import type { ExecResult } from '../worktree/exec.js';

test('parseNulPaths preserves quoted, non-ASCII, and control-character paths', () => {
  assert.deepEqual(
    parseNulPaths('src/café.ts\0quote"file.ts\0dir/line\nbreak.ts\0'),
    ['src/café.ts', 'quote"file.ts', 'dir/line\nbreak.ts'],
  );
});

test('parsePorcelainPaths parses NUL porcelain paths and rename/copy destinations', () => {
  const out = [
    ' M src/café.ts',
    '?? quote"file.ts',
    'A  src/back\\slash.ts',
    'R  src/new-name.ts',
    'src/old-name.ts',
    'C  src/copy-dst.ts',
    'src/copy-src.ts',
    '',
  ].join('\0');

  assert.deepEqual(parsePorcelainPaths(out), [
    'src/café.ts',
    'quote"file.ts',
    'src/back\\slash.ts',
    'src/new-name.ts',
    'src/copy-dst.ts',
  ]);
});

test('modifiedFilesForTask probes git with NUL-safe args and maps paths to project ids', async () => {
  const project = path.join('tmp', 'lattice-worktree-modified-probe');
  const worktreePath = path.join('tmp', 'worktree');
  const calls: string[][] = [];
  const files = await modifiedFilesForTask(
    makeTask({ projectPath: project, status: 'in_progress', worktreePath }),
    'trunk',
    async (_cmd, args): Promise<ExecResult> => {
      calls.push(args);
      if (args[0] === 'diff') {
        return { code: 0, stdout: 'src/café.ts\0.lattice/internal.json\0', stderr: '' };
      }
      return {
        code: 0,
        stdout: ['R  src/new-name.ts', 'src/old-name.ts', '?? quote"file.ts', ''].join('\0'),
        stderr: '',
      };
    },
  );

  assert.deepEqual(calls, [
    ['diff', '--name-only', '-z', 'trunk...HEAD'],
    ['status', '--porcelain=v1', '-z'],
  ]);
  const root = canonicalProjectPath(project);
  assert.deepEqual(files, [
    path.join(root, 'src/café.ts'),
    path.join(root, 'src/new-name.ts'),
    path.join(root, 'quote"file.ts'),
  ]);
});

test('worktree-modified service caches results and probes only active worktree tasks', async () => {
  let now = 1000;
  let listCalls = 0;
  let baseCalls = 0;
  const probed: Array<{ id: string; baseBranch: string }> = [];
  const project = path.join('tmp', 'lattice-worktree-modified');
  const tasks: Task[] = [
    makeTask({ id: 'active-a', projectPath: project, status: 'in_progress', worktreePath: '/wt/a', colorIndex: 2 }),
    makeTask({ id: 'active-b', projectPath: project, status: 'ready_to_merge', worktreePath: '/wt/b' }),
    makeTask({ id: 'open', projectPath: project, status: 'open', worktreePath: '/wt/open' }),
    makeTask({ id: 'missing-worktree', projectPath: project, status: 'in_progress' }),
  ];

  const service = createWorktreeModifiedService({
    ttlMs: 50,
    now: () => now,
    listTasks: async () => {
      listCalls += 1;
      return tasks;
    },
    resolveBaseBranch: async () => {
      baseCalls += 1;
      return 'trunk';
    },
    modifiedFilesForTask: async (task, baseBranch) => {
      probed.push({ id: task.id, baseBranch });
      return task.id === 'active-b' ? [] : [`${task.projectPath}/${task.id}.ts`];
    },
  });

  assert.deepEqual(await service.load(project), {
    tasks: [{ taskId: 'active-a', colorIndex: 2, files: [`${project}/active-a.ts`] }],
  });
  assert.equal(listCalls, 1);
  assert.equal(baseCalls, 1);
  assert.deepEqual(probed, [
    { id: 'active-a', baseBranch: 'trunk' },
    { id: 'active-b', baseBranch: 'trunk' },
  ]);

  assert.deepEqual(await service.load(project), {
    tasks: [{ taskId: 'active-a', colorIndex: 2, files: [`${project}/active-a.ts`] }],
  });
  assert.equal(listCalls, 1, 'fresh cache hit must not reload tasks');
  assert.equal(baseCalls, 1, 'fresh cache hit must not resolve the base branch');
  assert.equal(probed.length, 2, 'fresh cache hit must not re-probe worktrees');

  now += 51;
  await service.load(project);
  assert.equal(listCalls, 2);
  assert.equal(baseCalls, 2);
  assert.equal(probed.length, 4);
});

test('base branch resolver falls back without caching failures and caches successes', async () => {
  const results: ExecResult[] = [
    { code: 1, stdout: '', stderr: 'not a repo' },
    { code: 0, stdout: 'trunk\n', stderr: '' },
    { code: 0, stdout: 'should-not-be-read\n', stderr: '' },
  ];
  let calls = 0;
  const resolver = createBaseBranchResolver(async () => {
    const result = results[calls];
    calls += 1;
    return result;
  });

  assert.equal(await resolver.resolve('/repo'), DEFAULT_BASE_BRANCH);
  assert.equal(calls, 1);
  assert.equal(await resolver.resolve('/repo'), 'trunk');
  assert.equal(calls, 2);
  assert.equal(await resolver.resolve('/repo'), 'trunk');
  assert.equal(calls, 2, 'successful base-branch probe should be cached');
});

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'task',
    projectPath: '/project',
    title: 'Task',
    status: 'open',
    createdAt: 1,
    ...overrides,
  };
}

test('worktree-modified service single-flights concurrent loads of one project', async () => {
  let listCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const project = path.join('tmp', 'lattice-worktree-modified-sf');
  const service = createWorktreeModifiedService({
    ttlMs: 50,
    now: () => 0,
    listTasks: async () => {
      listCalls += 1;
      await gate;
      return [makeTask({ id: 'a', projectPath: project, status: 'in_progress', worktreePath: '/wt/a' })];
    },
    resolveBaseBranch: async () => 'trunk',
    modifiedFilesForTask: async () => ['f.ts'],
  });
  const first = service.load(project);
  const second = service.load(project);
  assert.equal(listCalls, 1, 'the second caller joins the in-flight load');
  release();
  assert.deepEqual(await first, await second);
  assert.equal(listCalls, 1);
});
