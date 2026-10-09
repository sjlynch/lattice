// Run tests step normalization and parsers (pure, plus one real-repo git read):
// normalizeSteps keeps kind 'test' (never silently 'agent') and clamps
// timeoutMinutes on Run tests steps only; the user-WIP porcelain parser reads
// renames (both paths), spaces, quotes and untracked dirs; the post-check's
// commit/file log parser; run-tests.json state parsing rejects junk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeSteps } from '../workflows.js';
import { parsePorcelainZ, parseUserWipFile, renderUserWipFile, wipCovers } from '../workflowRuns/testStep/userWip.js';
import { parseLogNameOnlyZ, readProjectStatusPaths } from '../workflowRuns/testStep/checkoutGit.js';
import { composeStepSummary, renderPostCheck } from '../workflowRuns/testStep/summary.js';
import { parseRunTestsState } from '../workflowRuns/testStep/runTestsState.js';

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

test("normalizeSteps keeps kind 'test' and clamps timeoutMinutes (test steps only)", () => {
  const [plain, set, low, high, junk, agent] = normalizeSteps([
    { title: 'a', kind: 'test' },
    { title: 'b', kind: 'test', timeoutMinutes: 42.4 },
    { title: 'c', kind: 'test', timeoutMinutes: 1 },
    { title: 'd', kind: 'test', timeoutMinutes: 99999 },
    { title: 'e', kind: 'test', timeoutMinutes: 'soon' },
    { title: 'f', kind: 'agent', timeoutMinutes: 30 },
  ]);
  assert.equal(plain.kind, 'test', "'test' must not silently become 'agent'");
  assert.equal(plain.timeoutMinutes, undefined, 'absent = the 60-minute default');
  assert.equal(set.timeoutMinutes, 42);
  assert.equal(low.timeoutMinutes, 5);
  assert.equal(high.timeoutMinutes, 720);
  assert.equal(junk.timeoutMinutes, undefined);
  assert.equal(agent.timeoutMinutes, undefined, 'only Run tests steps carry a timeout');
  assert.equal('timeoutMinutes' in JSON.parse(JSON.stringify(agent)), false);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parsePorcelainZ reads renames (both paths), spaces, quotes and untracked dirs', () => {
  const out = parsePorcelainZ(' M a b.txt\0R  new name.ts\0old "q".ts\0?? dir/\0A  ünï.md\0');
  assert.deepEqual(out, ['a b.txt', 'new name.ts', 'old "q".ts', 'dir/', 'ünï.md']);
  assert.ok(wipCovers(out, 'dir/inner/file.ts'), 'an untracked dir covers what is under it');
  assert.ok(!wipCovers(out, 'other.ts'));
  assert.deepEqual(parseUserWipFile(renderUserWipFile(out)), out);
});

test('readProjectStatusPaths parses a real repo (rename + quoted + untracked dir)', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-runtests-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'main');
    await fs.writeFile(path.join(repo, 'old.txt'), 'x');
    await fs.writeFile(path.join(repo, 'a b.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    git('mv', 'old.txt', 'new.txt');
    await fs.writeFile(path.join(repo, 'a b.txt'), 'changed');
    await fs.mkdir(path.join(repo, 'untracked dir'));
    await fs.writeFile(path.join(repo, 'untracked dir', 'f.txt'), 'x');
    const paths = await readProjectStatusPaths(repo);
    assert.ok(paths);
    assert.deepEqual([...paths!].sort(), ['a b.txt', 'new.txt', 'old.txt', 'untracked dir/'].sort());
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('parseLogNameOnlyZ splits commits and their files', () => {
  const out = parseLogNameOnlyZ('\x1eabc1234\tfix one\0\na.ts\0b c.ts\0\x1edef5678\tsecond\0\nz.ts\0');
  assert.deepEqual(out, [
    { sha: 'abc1234', subject: 'fix one', files: ['a.ts', 'b c.ts'] },
    { sha: 'def5678', subject: 'second', files: ['z.ts'] },
  ]);
  assert.equal(renderPostCheck([], null), '**Commits by this step:** none.');
  assert.equal(composeStepSummary({ notes: [], report: null, reportExpected: true, postCheck: '' }), '_The agent did not write TEST_SUMMARY.md._');
});

test('run-tests.json state parsing rejects junk', () => {
  assert.deepEqual(parseRunTestsState({ lastHead: 'abcdef1', lastFinishedAt: 5 }), { lastHead: 'abcdef1', lastFinishedAt: 5 });
  assert.equal(parseRunTestsState({ lastHead: 'not a sha', lastFinishedAt: 5 }), null);
  assert.equal(parseRunTestsState(null), null);
});
