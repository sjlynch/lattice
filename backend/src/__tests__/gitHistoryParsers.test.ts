import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitLogFormat, parseGitLogNameStatus } from '../gitHistory/parseLog.js';
import { parseGitStatusPorcelain } from '../gitHistory/parseStatus.js';
import { GIT_LOG_COMMIT_HEADER, GIT_LOG_FIELD_SEPARATOR } from '../gitHistory/parserShared.js';

function commitHeader(
  sha: string,
  shortSha: string,
  authorName: string,
  atSec: number,
  subject: string,
): string {
  return [
    `${GIT_LOG_COMMIT_HEADER}${sha}`,
    shortSha,
    authorName,
    String(atSec),
    subject,
  ].join(GIT_LOG_FIELD_SEPARATOR);
}

test('gitLogFormat emits the shared parser sentinels', () => {
  assert.equal(
    gitLogFormat(),
    [`${GIT_LOG_COMMIT_HEADER}%H`, '%h', '%an', '%at', '%s'].join(GIT_LOG_FIELD_SEPARATOR),
  );
});

test('parseGitLogNameStatus parses A/M/D records, blank lines, and oldest-to-newest order', () => {
  const out =
    `${commitHeader('2222222222222222222222222222222222222222', '2222222', 'Bob', 1700000002, 'newer')}\n` +
    `M\tfrontend\\App.tsx\n` +
    `\n` +
    `${commitHeader('1111111111111111111111111111111111111111', '1111111', 'Alice', 1700000001, 'older')}\n` +
    `A\tsrc/new.ts\n` +
    `D\tsrc/old.ts\n` +
    `\n`;

  const commits = parseGitLogNameStatus(out);

  assert.equal(commits.length, 2);
  assert.equal(commits[0].sha, '1111111111111111111111111111111111111111');
  assert.equal(commits[0].shortSha, '1111111');
  assert.equal(commits[0].subject, 'older');
  assert.equal(commits[0].authorName, 'Alice');
  assert.equal(commits[0].date, 1700000001000);
  assert.deepEqual(commits[0].changes, [
    { path: 'src/new.ts', status: 'A' },
    { path: 'src/old.ts', status: 'D' },
  ]);
  assert.equal(commits[1].sha, '2222222222222222222222222222222222222222');
  assert.deepEqual(commits[1].changes, [{ path: 'frontend/App.tsx', status: 'M' }]);
});

test('parseGitLogNameStatus parses rename and copy records as delete/add pairs', () => {
  const out =
    `${commitHeader('3333333333333333333333333333333333333333', '3333333', 'Carol', 1700000003, 'moves')}\n` +
    `R100\told\\name.ts\tnew/name.ts\n` +
    `C75\tsrc/base.ts\tsrc/copy.ts\n`;

  const commits = parseGitLogNameStatus(out);

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].changes, [
    { path: 'old/name.ts', status: 'D' },
    { path: 'new/name.ts', status: 'A', oldPath: 'old/name.ts' },
    { path: 'src/base.ts', status: 'D' },
    { path: 'src/copy.ts', status: 'A', oldPath: 'src/base.ts' },
  ]);
});

test('parseGitLogNameStatus keeps non-ASCII paths literal (core.quotePath=false output)', () => {
  // With `-c core.quotePath=false`, git emits accented/CJK filenames
  // literally as UTF-8 rather than C-quoting them (`"caf\303\251.ts"`).
  // The parser must preserve those bytes so the path equals the graph's
  // file-node id and the commit change-ring resolves.
  const out =
    `${commitHeader('4444444444444444444444444444444444444444', '4444444', 'Dora', 1700000004, 'unicode')}\n` +
    `M\tcafé.ts\n` +
    `A\t日本語.ts\n` +
    `R100\tnaïve\\old.ts\tnaïve/new.ts\n`;

  const commits = parseGitLogNameStatus(out);

  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].changes, [
    { path: 'café.ts', status: 'M' },
    { path: '日本語.ts', status: 'A' },
    { path: 'naïve/old.ts', status: 'D' },
    { path: 'naïve/new.ts', status: 'A', oldPath: 'naïve/old.ts' },
  ]);
});

test('parseGitStatusPorcelain parses untracked, added, modified, deleted, and backslash paths', () => {
  const result = parseGitStatusPorcelain(
    `?? untracked.ts\0` +
      `A  added.ts\0` +
      ` M nested\\modified.ts\0` +
      ` D deleted.ts\0`,
  );

  assert.deepEqual(result.changes, [
    { path: 'untracked.ts', status: 'A' },
    { path: 'added.ts', status: 'A' },
    { path: 'nested/modified.ts', status: 'M' },
    { path: 'deleted.ts', status: 'D' },
  ]);
});

test('parseGitStatusPorcelain parses rename records as old delete plus new add', () => {
  const result = parseGitStatusPorcelain(`R  new\\name.ts\0old\\name.ts\0`);

  assert.deepEqual(result.changes, [
    { path: 'old/name.ts', status: 'D' },
    { path: 'new/name.ts', status: 'A' },
  ]);
});

test('parseGitStatusPorcelain keeps dirty priority D > A > M per path', () => {
  const result = parseGitStatusPorcelain(
    ` M promoted.ts\0` +
      `A  promoted.ts\0` +
      ` D promoted.ts\0` +
      `D  not-downgraded.ts\0` +
      `A  not-downgraded.ts\0` +
      ` M not-downgraded.ts\0`,
  );

  assert.deepEqual(result.changes, [
    { path: 'promoted.ts', status: 'D' },
    { path: 'not-downgraded.ts', status: 'D' },
  ]);
});

test('parseGitStatusPorcelain consumes the old path of a copy record like a rename', () => {
  // `status.renames=copies` emits `C  new\0old\0`; the old path must not be
  // parsed as a record of its own (with its first three characters lost).
  const result = parseGitStatusPorcelain(`C  copy.ts\0source.ts\0 M other.ts\0`);

  assert.deepEqual(result.changes, [
    { path: 'copy.ts', status: 'A' },
    { path: 'other.ts', status: 'M' },
  ]);
});
