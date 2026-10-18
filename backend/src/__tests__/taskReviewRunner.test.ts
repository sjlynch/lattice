// All reviewer execution crosses an injected CLI boundary. These tests inspect
// commands/stdin and write fake Codex output, never invoking a coding harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runTaskReview, reviewScratchPaths } from '../taskReview/runner.js';
import { spawnWithTimeout, type SpawnWithTimeoutResult } from '../spawnWithTimeout.js';
import type { Task } from '../tasks.js';

const task: Task = { id: 't_100_abc12', title: 'Fix missing keys', description: 'Include fallback',
  projectPath: path.join(os.tmpdir(), 'review-runner-project'), status: 'in_progress', createdAt: 1,
  review: { status: 'reviewing', head: 'a'.repeat(40), startedAt: 2, attempt: 1 } };
const success = (partial: Partial<SpawnWithTimeoutResult> = {}): SpawnWithTimeoutResult => ({
  code: 0, stdout: '', stderr: '', combined: '', error: null, timedOut: false, ...partial,
});
const reply = '{"verdict":"accept","p":98,"reason":"Complete fix"}';
const collect = async () => [{ path: 'a.ts', diff: 'patch', before: 'original', test: false }];

test('Codex reviewer uses the bounded ephemeral CLI, stdin and guarded home scratch', async () => {
  let cleaned = false;
  const result = await runTaskReview(task, {}, {
    collect,
    spawn: async (command, args, opts) => {
      assert.equal(command, 'codex');
      assert.match(args.at(-2)!, /^verdict-[a-f0-9]+\.json$/);
      assert.deepEqual(args, ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-m', 'gpt-6.1-sol',
        '-c', 'model_reasoning_effort=low', '-o', args.at(-2), '-']);
      assert.equal(opts.timeoutMs, 600_000);
      assert.equal(opts.cwd, reviewScratchPaths.assertSafeSessionPath(task.projectPath, task.id));
      assert.ok(!opts.cwd!.startsWith(task.projectPath + path.sep));
      assert.match(opts.input!, /TASK the agent was given:\nFix missing keys\n\nInclude fallback/);
      await fs.writeFile(path.join(opts.cwd!, args.at(-2)!), reply);
      return success();
    },
    cleanup: async ({ paths, projectPath, id }) => {
      cleaned = true;
      await fs.rm(paths.assertSafeSessionPath(projectPath, id), { recursive: true, force: true });
    },
  });
  assert.deepEqual(result, { verdict: 'accept', p: 98, reason: 'Complete fix', reviewer: 'codex/gpt-6.1-sol' });
  assert.equal(cleaned, true);
  assert.throws(() => reviewScratchPaths.assertSafeSessionPath(task.projectPath, '../main'));
});

test('Claude reviewer reads text stdout, uses its default and omits Codex effort', async () => {
  const result = await runTaskReview(task, { taskReviewHarness: 'claude', taskReviewEffort: 'max' }, {
    collect,
    spawn: async (command, args) => {
      assert.equal(command, 'claude');
      assert.deepEqual(args, ['-p', '--model', 'claude-sonnet-5-5']);
      return success({ stdout: reply });
    },
    cleanup: async ({ paths, projectPath, id }) => fs.rm(paths.assertSafeSessionPath(projectPath, id), { recursive: true, force: true }),
  });
  assert.equal(result.verdict, 'accept');
  assert.equal(result.reviewer, 'claude/claude-sonnet-5-5');
});

test('missing CLI, timeout, nonzero exit and invalid output all yield error and cleanup', async () => {
  for (const cli of [success({ error: new Error('ENOENT') }), success({ timedOut: true }), success({ code: 1 }), success({ stdout: '{}' })]) {
    let cleaned = false;
    const result = await runTaskReview(task, { taskReviewHarness: 'claude', taskReviewModel: 'custom-model' }, {
      collect, spawn: async () => cli,
      cleanup: async ({ paths, projectPath, id }) => {
        cleaned = true;
        await fs.rm(paths.assertSafeSessionPath(projectPath, id), { recursive: true, force: true });
      },
    });
    assert.equal(result.verdict, 'error');
    assert.equal(result.reviewer, 'claude/custom-model');
    assert.equal(cleaned, true);
  }
});

test('Codex cannot reuse a stale verdict file from a previous head', async () => {
  const cwd = reviewScratchPaths.assertSafeSessionPath(task.projectPath, task.id);
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(path.join(cwd, 'verdict.json'), reply);
  const result = await runTaskReview(task, {}, {
    collect, spawn: async () => success(),
    cleanup: async () => fs.rm(cwd, { recursive: true, force: true }),
  });
  assert.equal(result.verdict, 'error');
});

test('spawnWithTimeout sends stdin, drains bounded output, and times out a stuck child', async () => {
  const result = await spawnWithTimeout(process.execPath, ['-e',
    'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s.repeat(100)))'],
    { timeoutMs: 10_000, input: 'hello', maxOutputChars: 20 });
  assert.equal(result.stdout, 'hello'.repeat(4));
  assert.equal(result.code, 0);
  const timed = await spawnWithTimeout(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
});
