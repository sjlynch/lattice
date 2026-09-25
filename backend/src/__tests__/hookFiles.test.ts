import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  candidateFilesFromShell,
  filesFromApplyPatch,
  filesFromHookBody,
  MAX_CANDIDATES_PER_TOOL_USE,
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

// `cd frontend && cat package.json` used to yield bare `package.json`, which
// resolved to the ROOT package.json (it exists) — a confident wrong beam.
test('candidateFilesFromShell resolves later tokens under a leading cd', () => {
  const fe = path.join('frontend', 'package.json');
  assert.deepEqual(candidateFilesFromShell('cd frontend && cat package.json'), [fe]);
  assert.deepEqual(candidateFilesFromShell('cd "frontend"; cat package.json'), [fe]);
  assert.deepEqual(candidateFilesFromShell("bash -lc \"cd frontend && sed -n '1,80p' package.json\""), [fe]);
  assert.deepEqual(candidateFilesFromShell("/bin/bash -lc 'cd frontend && cat package.json'"), [fe]);
  // argv-array form, joined by filesFromHookBody's commandText.
  assert.deepEqual(candidateFilesFromShell('bash -lc cd frontend && cat package.json'), [fe]);
  assert.deepEqual(
    candidateFilesFromShell('pwsh -NoProfile -Command "Set-Location frontend; Get-Content package.json"'),
    [fe],
  );
  assert.deepEqual(candidateFilesFromShell('Set-Location -Path frontend; Get-Content package.json'), [fe]);
  // An absolute target (a workflow step cd-ing into the project) resolves to an
  // absolute path; an absolute token ignores the cd.
  const root = path.resolve('some-project');
  assert.deepEqual(candidateFilesFromShell(`cd ${root}; Get-Content src/x.ts`), [path.join(root, 'src', 'x.ts')]);
  const absTok = path.resolve('elsewhere', 'y.ts');
  assert.deepEqual(candidateFilesFromShell(`cd frontend && cat ${absTok}`), [absTok]);
});

test('candidateFilesFromShell drops candidates it cannot place (a miss beats a wrong beam)', () => {
  assert.deepEqual(candidateFilesFromShell('cd frontend && cd src && cat app.ts'), []);
  assert.deepEqual(candidateFilesFromShell('cat a.ts && cd frontend && cat package.json'), []);
  assert.deepEqual(candidateFilesFromShell('pushd frontend && cat package.json'), []);
  assert.deepEqual(candidateFilesFromShell('(cd frontend && cat package.json)'), []);
  assert.deepEqual(candidateFilesFromShell('cd $DIR && cat package.json'), []);
  assert.deepEqual(candidateFilesFromShell('cd ~/proj && cat package.json'), []);
  assert.deepEqual(candidateFilesFromShell('cd - && cat package.json'), []);
  assert.deepEqual(candidateFilesFromShell('cd frontend'), []);
});

test('candidateFilesFromShell reads a shell-run apply_patch heredoc as a patch', () => {
  const cmd = [
    "apply_patch <<'EOF'",
    '*** Begin Patch',
    '*** Update File: src/a.ts',
    '@@',
    "-import x from './x.js';",
    "+import y from './y.js'; // cd into it",
    '*** End Patch',
    'EOF',
  ].join('\n');
  assert.deepEqual(candidateFilesFromShell(cmd), ['src/a.ts']);
  assert.deepEqual(candidateFilesFromShell(`cd backend && ${cmd}`), [path.join('backend', 'src', 'a.ts')]);
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

// The 8-per-tool-use cap now applies after the existence check (activityHook),
// so the raw candidate list is only bounded, not capped.
test('filesFromHookBody returns shell candidates uncapped (bounded) for the existence check', () => {
  const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`).join(' ');
  const got = filesFromHookBody({ tool_name: 'Bash', tool_input: { command: `cat ${many}` } });
  assert.equal(got.files.length, 20);
  assert.equal(got.mustExist, true);

  const huge = Array.from({ length: 200 }, (_, i) => `g${i}.ts`).join(' ');
  const bounded = filesFromHookBody({ tool_name: 'Bash', tool_input: { command: `cat ${huge}` } });
  assert.equal(bounded.files.length, MAX_CANDIDATES_PER_TOOL_USE);
});

test('filesFromHookBody accepts argv-array shell commands (exec_command cmd)', () => {
  assert.deepEqual(
    filesFromHookBody({ tool_name: 'exec_command', tool_input: { cmd: ['cat', 'x/y.py'] } }),
    { files: ['x/y.py'], mustExist: true },
  );
});

test('filesFromHookBody honours a shell tool workdir', () => {
  assert.deepEqual(
    filesFromHookBody({ tool_name: 'exec_command', tool_input: { cmd: 'cat package.json', workdir: 'frontend' } }),
    { files: [path.join('frontend', 'package.json')], mustExist: true },
  );
  // workdir, then a leading cd inside it.
  assert.deepEqual(
    filesFromHookBody({
      tool_name: 'exec_command',
      tool_input: { cmd: ['bash', '-lc', 'cd src && cat app.ts'], workdir: 'frontend' },
    }),
    { files: [path.join('frontend', 'src', 'app.ts')], mustExist: true },
  );
  const abs = path.resolve('proj', 'backend');
  assert.deepEqual(
    filesFromHookBody({ tool_name: 'exec_command', tool_input: { cmd: 'cat index.ts', workdir: abs } }),
    { files: [path.join(abs, 'index.ts')], mustExist: true },
  );
});

test('filesFromHookBody existence-checks apply_patch headers', () => {
  const patch = '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n*** End Patch';
  assert.deepEqual(
    filesFromHookBody({ tool_name: 'apply_patch', tool_input: { command: patch } }),
    { files: ['a.ts', 'b.ts'], mustExist: true },
  );
});

test('filesFromHookBody prefers an explicit file_path (Claude / Pi shape)', () => {
  assert.deepEqual(
    filesFromHookBody({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }),
    { files: ['src/a.ts'], mustExist: false },
  );
});
