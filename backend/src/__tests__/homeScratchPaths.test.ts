import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {
  createHomeScratchPaths,
  isPathInsideOrSame,
  isPathStrictlyInside,
  safeRelative,
} from '../homeScratch/paths.js';

// The home-scoped scratch path guard is part of the repo's `.git`-deletion
// defence layer: it is what keeps the recursive scratch cleanup bounded to
// `~/.lattice/per-project/<hash>/<dir>/` and out of the project's `.git`.
// pushRuns / qaRuns / postMergeHooks all share this one factory, so this is
// the single place that contract is exercised.

const push = createHomeScratchPaths({
  dirName: 'push',
  idPrefix: 'push',
  logLabel: '[pushRuns]',
  noun: 'push session',
});

const project = path.join(os.homedir(), 'some-project');

test('createSessionId mints a guard-accepted id', () => {
  const id = push.createSessionId();
  assert.match(id, /^push_\d+_[0-9a-f]+$/);
  // A freshly-minted id must always survive the guard and resolve to its dir.
  const dir = push.assertSafeSessionPath(project, id);
  assert.equal(dir, path.resolve(push.sessionDir(project, id)));
});

test('the scratch dir is strictly under the home scratch root', () => {
  const id = push.createSessionId();
  const dir = push.assertSafeSessionPath(project, id);
  const root = path.resolve(push.sessionsRoot(project));
  assert.ok(isPathStrictlyInside(root, dir));
  // ...and NOT inside the project repo (the whole point of home-scoping).
  assert.equal(isPathInsideOrSame(path.resolve(project), dir), false);
});

test('the guard refuses malformed ids', () => {
  for (const bad of [
    '',
    'push',
    'push_123',
    'qa_123_abc', // wrong prefix
    'PUSH_123_abc', // case-sensitive prefix
    'push_abc_def', // non-numeric ts
    'push_123_xyz', // non-hex suffix
  ]) {
    assert.throws(
      () => push.assertSafeSessionPath(project, bad),
      /refusing invalid push session id/,
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test('the guard refuses ids that try to escape the scratch root', () => {
  // Path separators / traversal can never pass the id regex, so the join can't
  // climb out of the scratch root.
  for (const escape of [
    'push_1_aa/../../evil',
    'push_1_aa\\..\\evil',
    '../push_1_aa',
    'push_1_aa/nested',
  ]) {
    assert.throws(
      () => push.assertSafeSessionPath(project, escape),
      /refusing invalid push session id/,
    );
  }
});

test('the id prefix is feature-specific', () => {
  const qa = createHomeScratchPaths({
    dirName: 'qa',
    idPrefix: 'qa',
    logLabel: '[qaRuns]',
    noun: 'qa session',
  });
  // A push id must not validate under the qa guard, and vice-versa.
  assert.throws(
    () => qa.assertSafeSessionPath(project, push.createSessionId()),
    /refusing invalid qa session id/,
  );
  assert.throws(
    () => push.assertSafeSessionPath(project, qa.createSessionId()),
    /refusing invalid push session id/,
  );
});

test('safeRelative rejects unsafe inputs', () => {
  assert.equal(safeRelative('', '/a'), null);
  assert.equal(safeRelative('/a', ''), null);
  assert.equal(safeRelative('/a\0b', '/a'), null);
});
