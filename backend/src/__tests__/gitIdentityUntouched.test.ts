import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertAllowedProjectGitArgs,
  DisallowedProjectGitError,
} from '../worktree/projectGit.js';
import { DEFAULT_TASK_TEMPLATE } from '../instructionTemplates/templates/task.js';
import { DEFAULT_MERGE_TEMPLATE } from '../instructionTemplates/templates/merge.js';
import { DEFAULT_PUSH_TEMPLATE } from '../instructionTemplates/templates/push.js';
import { DEFAULT_POST_MERGE_HOOK_TEMPLATE } from '../instructionTemplates/templates/postMergeHook.js';
import { DEFAULT_RUN_TESTS_TEMPLATE } from '../instructionTemplates/templates/runTests.js';

// Lattice must never write the HOST's git identity/config.
//
// Every Lattice-spawned agent runs permission-bypassed (`claude
// --dangerously-skip-permissions`, `codex --yolo`, `pi --approve`) and several
// of the briefs tell it to `git commit`. When git can't resolve an identity it
// fails with text that literally instructs the reader to run
// `git config --global user.name "Your Name"` — and a full-auto agent will
// comply, stamping a placeholder identity onto the user's `~/.gitconfig`. The
// user's own commits then carry it until they notice.
//
// Three layers keep that from happening, and this file pins all three:
//   1. `projectGit` refuses `config` outright, so no Lattice code path can run
//      it against the project repo even by accident.
//   2. No Lattice source sets a git identity — not via `git config`, not via
//      the `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env overrides. Verified by
//      scanning the shipped source, so a future edit has to trip this test.
//   3. Every brief that tells an agent to commit also tells it NOT to fix an
//      identity error with `git config`.
//
// Note this is a *host config* invariant, not a "don't set identity anywhere"
// one: `__tests__/` legitimately runs `git config user.email …` inside its own
// throwaway temp repos, so the scan skips this directory.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..');

// High-signal markers for a git-identity / host-config write. Deliberately not
// a bare `'config'` — that string appears in unrelated code (health-watcher
// rescan reasons, MCP config plumbing) and would make this test noise. The
// `--global`/`--system` scope flags are matched with a trailing boundary so
// Claude's `--system-prompt-file` flag isn't read as `git config --system`.
const FORBIDDEN_MARKERS = [
  /--global(?![-\w])/,
  /--system(?![-\w])/,
  /GIT_AUTHOR_NAME/,
  /GIT_AUTHOR_EMAIL/,
  /GIT_COMMITTER_NAME/,
  /GIT_COMMITTER_EMAIL/,
  /user\.name/,
  /user\.email/,
];

async function collectSourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue; // temp-repo fixtures set their own identity
      await collectSourceFiles(full, out);
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

test('projectGit refuses `git config` against the project repo', () => {
  const denied = (args: string[]) =>
    assert.throws(
      () => assertAllowedProjectGitArgs(args),
      DisallowedProjectGitError,
      `expected denied: git ${args.join(' ')}`,
    );

  // The exact shapes git's "Author identity unknown" message suggests.
  denied(['config', '--global', 'user.name', 'Test User']);
  denied(['config', '--global', 'user.email', 'test@example.com']);
  denied(['config', 'user.name', 'Test User']);
  denied(['config', '--system', 'user.name', 'Test User']);
  denied(['config', '--list']); // even the read form — Lattice has no need for it
  // ...and the `-c` override form, which is already rejected as a leading option.
  denied(['-c', 'user.name=Test User', 'commit', '-m', 'x']);
});

test('no shipped backend source writes a git identity or host git config', async () => {
  const files = await collectSourceFiles(SRC_ROOT);
  assert.ok(files.length > 100, 'source scan found suspiciously few files');

  const hits: string[] = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    // The instruction templates name these markers on purpose — to tell the
    // agent NOT to use them.
    if (file.includes(`${path.sep}instructionTemplates${path.sep}`)) continue;
    for (const marker of FORBIDDEN_MARKERS) {
      if (marker.test(text)) hits.push(`${path.relative(SRC_ROOT, file)}: ${marker.source}`);
    }
  }

  assert.deepEqual(
    hits,
    [],
    `Lattice must never set a git identity or write host git config. Found:\n${hits.join('\n')}`,
  );
});

test('every commit-instructing brief routes an identity error to a per-commit recovery', () => {
  const briefs: Array<[string, string]> = [
    ['task', DEFAULT_TASK_TEMPLATE],
    ['merge', DEFAULT_MERGE_TEMPLATE],
    ['push', DEFAULT_PUSH_TEMPLATE],
    ['post-merge-hook', DEFAULT_POST_MERGE_HOOK_TEMPLATE],
    ['run-tests', DEFAULT_RUN_TESTS_TEMPLATE],
  ];
  for (const [id, template] of briefs) {
    // A prohibition is only useful if it names the failure that provokes it —
    // this is the exact text git prints, and the text that tells the agent to
    // run `git config --global`.
    assert.ok(
      template.includes('Author identity unknown'),
      `${id} brief must name the identity error it is guarding against`,
    );
    assert.ok(
      template.includes('never fix it with `git config`'),
      `${id} brief lost the "never fix it with git config" rule`,
    );
    // `--local` is the trap an agent falls into once it's told not to use
    // `--global`: a worktree shares the project repo's config file.
    assert.ok(
      template.includes('`--local`'),
      `${id} brief must rule out --local as well as --global`,
    );
    // The load-bearing half: a recovery that persists nothing, so the agent
    // finishes the job instead of stalling on a machine with no identity.
    assert.ok(
      template.includes('git -c user.name='),
      `${id} brief must offer the per-commit -c recovery`,
    );
    assert.ok(
      template.includes('git log -1 --format="%an <%ae>"'),
      `${id} brief must tell the agent where to FIND an identity`,
    );
  }
});
