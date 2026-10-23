import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { createHomeScratchPaths } from '../homeScratch/paths.js';
import { cleanupHomeScratchSession } from '../homeScratch/cleanup.js';
import { assertNotReparsePoint } from '../worktree/cleanupSafety.js';
import { taskReviewerIn, type UserSettings } from '../userSettings.js';
import { canonicalProjectPath } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
import type { Task } from '../tasks.js';
import { collectReviewFiles } from './git.js';
import { parseReviewReply, renderReviewPrompt, type ReviewReply } from './prompt.js';

export const reviewScratchPaths = createHomeScratchPaths({
  dirName: 'reviews', idPrefix: 't', idPattern: /^t_\d+_[a-z0-9]+$/,
  logLabel: '[task-review]', noun: 'task review',
});

export type ReviewResult = (ReviewReply | { verdict: 'error'; reason: string; p?: undefined }) & { reviewer: string };

export function reviewScratchKey(project: string, taskId: string): string {
  return `taskReviewScratch:${canonicalProjectPath(project)}:${taskId}`;
}

export async function runTaskReview(task: Task, settings: UserSettings, deps = {
  spawn: spawnWithTimeout, collect: collectReviewFiles,
  cleanup: cleanupHomeScratchSession,
}): Promise<ReviewResult> {
  return runExclusive(reviewScratchKey(task.projectPath, task.id), async () => {
    const { harness, model, effort } = taskReviewerIn(settings);
    const reviewer = `${harness}/${model ?? 'default'}`;
    try {
      const cwd = reviewScratchPaths.assertSafeSessionPath(task.projectPath, task.id);
      await fs.mkdir(cwd, { recursive: true });
      await assertNotReparsePoint(cwd);
      // A CLI orphaned by a hard backend kill may still write its old output.
      // Unique outputs prevent even a same-head boot retry from consuming it.
      const output = `verdict-${randomBytes(8).toString('hex')}.json`;
      const files = await deps.collect(task, task.review!.head);
      const prompt = renderReviewPrompt(task.title, task.description ?? '', files);
      const args = harness === 'codex'
        ? ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-m', model!,
          '-c', `model_reasoning_effort=${effort}`, '-o', output, '-']
        : harness === 'pi'
          // Pi reads the prompt from stdin too; no tools, extensions, skills
          // or session — it only reads what the prompt carries.
          ? ['-p', ...(model ? ['--model', model] : []), '--thinking', effort,
            '--no-tools', '--no-extensions', '--no-skills', '--no-session']
          : ['-p', '--model', model!];
      // Windows resolves npm's codex.cmd through cmd. Every argv is fixed or
      // normalized to the harness model/effort grammar; all task text is stdin.
      const result = await deps.spawn(harness, args, {
        cwd, timeoutMs: 10 * 60_000, shell: process.platform === 'win32', input: prompt, maxOutputChars: 64_000,
      });
      if (result.error || result.timedOut || result.aborted || result.code !== 0) {
        throw new Error(result.timedOut ? 'Reviewer timed out' : result.error?.message ?? `Reviewer exited ${result.code}`);
      }
      const text = harness === 'codex' ? await readReviewOutput(path.join(cwd, output)) : result.stdout;
      const reply = parseReviewReply(text);
      if (!reply) throw new Error('Reviewer returned invalid JSON');
      return { ...reply, reviewer };
    } catch (error) {
      return { verdict: 'error', reviewer, reason: String(error instanceof Error ? error.message : error).slice(0, 300) };
    } finally {
      await deps.cleanup({ paths: reviewScratchPaths, projectPath: task.projectPath, id: task.id, logLabel: '[task-review]' });
    }
  });
}

async function readReviewOutput(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64_000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
