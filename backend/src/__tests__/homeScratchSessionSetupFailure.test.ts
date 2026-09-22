// startHomeScratchAgentSession (push / QA one-off agent sessions) only
// cleaned up its home scratch dir when the spawn queue returned `{ error }`.
// A failure earlier in setup — a hook install or brief render that throws —
// or a spawn-queue REJECTION left the freshly created dir behind until the
// next boot's sweep. Every failure between mkdir and a live pty now runs the
// feature's guarded cleanup for the session id it minted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHomeScratchPaths } from '../homeScratch/paths.js';
import { startHomeScratchAgentSession } from '../homeScratch/session.js';
import { withTempDir } from './helpers/tempDir.js';

test('a setup failure after mkdir cleans up the scratch dir it created', async () => {
  assert.match(path.basename(os.homedir()), /^lattice-test-home-/);
  await withTempDir('lattice-scratch-fail-', async (project) => {
    const paths = createHomeScratchPaths({
      dirName: 'scratch-fail-test', idPrefix: 'sft', logLabel: '[sft]', noun: 'test session',
    });
    const cleaned: string[] = [];
    let createdDir = '';
    await assert.rejects(
      startHomeScratchAgentSession({
        paths,
        projectPath: project,
        instructionsFileName: 'BRIEF.md',
        installHooks: async ({ cwd }) => {
          createdDir = cwd;
          throw new Error('hook install failed');
        },
        renderInstructions: () => 'unused',
        buildCommand: () => 'unused',
        queueKind: 'test',
        queuePriority: 'interactive',
        dedupeKeyPrefix: 'sft',
        onSpawned: () => assert.fail('must not spawn'),
        cleanup: async (projectPath, id) => {
          cleaned.push(id);
          await fs.rm(paths.assertSafeSessionPath(projectPath, id), { recursive: true, force: true });
        },
      }),
      /hook install failed/,
    );
    assert.equal(cleaned.length, 1, 'cleanup ran once for the minted session id');
    assert.equal(path.basename(createdDir), cleaned[0]);
    await assert.rejects(fs.access(createdDir), { code: 'ENOENT' });
    await fs.rm(paths.sessionsRoot(project), { recursive: true, force: true });
  });
});
