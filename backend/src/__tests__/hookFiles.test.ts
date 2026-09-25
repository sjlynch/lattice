import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateFilesFromShell,
  filesFromApplyPatch,
  filesFromHookBody,
  MAX_FILES_PER_TOOL_USE,
} from '../hookFiles.js';

test('candidateFilesFromShell picks file-looking tokens and skips flags/programs/globs', () => {
  assert.deepEqual(candidateFilesFromShell("sed -n '1,120p' src/app.ts"), ['src/app.ts']);
  assert.deepEqual(
    candidateFilesFromShell('Get-Content -Path "backend\src\index.ts" -TotalCount 40'),
    ['backend\src\index.ts'],
  );
  assert.deepEqual(candidateFilesFromShell('rg -n "foo.bar" src/*.ts | head -5'), ['foo.bar']);
  assert.deepEqual(candidateFilesFromShell('curl https://example.com/a.js'), []);
  assert.deepEqual(candidateFilesFromShell('FOO=bar.txt node x.js'), ['x.js']);
  assert.deepEqual(candidateFilesFromShell('git status'), []);
});

test('filesFromApplyPatch reads every file header, including a move target', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: a/one.ts',
    '*** Move to: a/two.ts',
    '*** Add File: b.md',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(filesFromApplyPatch(patch), ['a/one.ts', 'a/two.ts', 'b.md']);
});

test('filesFromHookBody caps a tool use at MAX_FILES_PER_TOOL_USE files', () => {
  const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join(' ');
  const got = filesFromHookBody({ tool_name: 'Bash', tool_input: { command: `cat ${many}` } });
  assert.equal(got.files.length, MAX_FILES_PER_TOOL_USE);
  assert.equal(got.speculative, true);
});

test('filesFromHookBody accepts argv-array shell commands (exec_command cmd)', () => {
  assert.deepEqual(
    filesFromHookBody({ tool_name: 'exec_command', tool_input: { cmd: ['cat', 'x/y.py'] } }),
    { files: ['x/y.py'], speculative: true },
  );
});

test('filesFromHookBody prefers an explicit file_path (Claude / Pi shape)', () => {
  assert.deepEqual(
    filesFromHookBody({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }),
    { files: ['src/a.ts'], speculative: false },
  );
});
