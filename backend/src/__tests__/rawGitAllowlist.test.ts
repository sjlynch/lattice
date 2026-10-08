// "All project-repo git goes through projectGit" (worktree/projectGit.ts — the
// subcommand whitelist that is defence #2 against `.git` deletion) used to be
// prose only. This makes it a rule: a module that launches `git` directly must
// be listed below with the reason it may. A new raw call site fails here —
// route it through `projectGit(repoRoot, args)` instead, unless it targets a
// disposable task worktree or is a read-only probe of a path that may not be a
// repo root (projectGit asserts `<repoRoot>/.git` exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const ALLOWED: Record<string, string> = {
  'worktree/projectGit.ts': 'the wrapper itself',
  'worktree/state.ts': 'worktree subsystem: .git integrity / HEAD probes behind projectGit',
  'worktree/conflictResolve.ts': 'runs in a disposable task worktree',
  'worktree/discardArchive.ts': 'runs in a disposable task worktree',
  'worktree/diskSpace.ts': 'read-only size probe',
  'worktree/lfsMode.ts': 'runs in a disposable task worktree',
  'worktree/merge/mergeResidue.ts': 'runs in a disposable task worktree',
  'worktree/mergeOwnedFiles.ts': 'runs in a disposable task worktree',
  'worktree/stopHook.ts': 'runs in a disposable task worktree',
  'worktree/merge/conflict.ts': 'commits a resolved merge in a disposable task worktree',
  'worktree/merge/runWorktreeMerge.ts': 'the real `git merge`, in a disposable task worktree',
  'worktree/envDetect.ts': 'read-only ls-files probe',
  'worktree/setupProject.ts': 'read-only rev-parse probe before a worktree is created',
  'gitBranch.ts': 'read-only HEAD probe; the path may not be a repo root',
  'gitHistory.ts': 'read-only log/ls-files/status probes; the path may not be a repo root',
  'gitHistory/signature.ts': 'read-only status probe',
  'workflowRuns/projectDirtyState.ts': 'read-only rev-parse probe',
  'projectInit/probe.ts': 'read-only probe of a folder that is not a repo yet',
  'projectInit/init.ts': '`git init` + first commit for a folder that is not a repo (Git Setup)',
  'opengrep/rulePackFetch.ts': 'clones rule packs under ~/.lattice/opengrep, not a project',
};

const RAW_GIT = /\b(?:exec|execFile|execFileSync|spawn|spawnSync|spawnWithTimeout)\(\s*['"]git['"]/;

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
}

test('only allowlisted modules launch git directly (everything else uses projectGit)', () => {
  const files: string[] = [];
  walk(SRC, files);
  const raw = files
    .filter((f) => RAW_GIT.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f).replace(/\\/g, '/'))
    .sort();
  const unlisted = raw.filter((f) => !(f in ALLOWED));
  assert.deepEqual(unlisted, [], 'route project-repo git through projectGit, or list the module here with its reason');
  const stale = Object.keys(ALLOWED).filter((f) => !raw.includes(f)).sort();
  assert.deepEqual(stale, [], 'these no longer launch git directly — drop them from the allowlist');
});
