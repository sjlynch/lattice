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
            '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session']
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
      return { ...(harness === 'pi' ? localVerdict(reply) : reply), reviewer };
    } catch (error) {
      return { verdict: 'error', reviewer, reason: String(error instanceof Error ? error.message : error).slice(0, 300) };
    } finally {
      await deps.cleanup({ paths: reviewScratchPaths, projectPath: task.projectPath, id: task.id, logLabel: '[task-review]' });
    }
  });
}

// A local model's own "accept" is lenient: ornith accepted 104 to 109 of 120
// balanced patches (half of them failing), so a Pi reviewer accepts only at
// p >= 90, where its accepts pass well above the base rate (83% and 63% on two
// sets of 120, vs 50%). It is a weaker gate than sol/low (AUC 0.65 vs 0.79 on
// a held-out set) — a free option, not the default. An explicit reject stays
// a reject whatever p says.
export const LOCAL_ACCEPT_P = 90;

function localVerdict(reply: ReviewReply): ReviewReply {
  if (reply.verdict === 'reject' || reply.p >= LOCAL_ACCEPT_P) return reply;
  return { ...reply, verdict: 'reject', reason: `p ${reply.p} is under the local reviewer's bar of ${LOCAL_ACCEPT_P}: ${reply.reason}`.slice(0, 300) };
}

async function readReviewOutput(file: string): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64_000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}
