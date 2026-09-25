import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLatticeOwnedConflictPath,
  LATTICE_OWNED_FILE_PATHS,
  LATTICE_GITIGNORE_ENTRIES,
  LATTICE_EXCLUDE_PATTERNS,
} from '../worktree/managedFiles.js';

test('isLatticeOwnedConflictPath matches the explicit owned set', () => {
  for (const p of LATTICE_OWNED_FILE_PATHS) {
    assert.equal(isLatticeOwnedConflictPath(p), true, `expected ${p} to be owned`);
  }
});

test('isLatticeOwnedConflictPath matches Windows-style separators', () => {
  assert.equal(
    isLatticeOwnedConflictPath('.claude\\settings.local.json'),
    true,
  );
});

test('isLatticeOwnedConflictPath matches the STASH_CONFLICT glob', () => {
  assert.equal(isLatticeOwnedConflictPath('STASH_CONFLICT_run.md'), true);
  assert.equal(isLatticeOwnedConflictPath('STASH_CONFLICT_zjia6.md'), true);
  assert.equal(isLatticeOwnedConflictPath('STASH_CONFLICT_t-1.md'), true);
});

test('isLatticeOwnedConflictPath rejects unrelated paths', () => {
  assert.equal(isLatticeOwnedConflictPath('src/index.ts'), false);
  assert.equal(isLatticeOwnedConflictPath('.claude/agents/foo.md'), false);
  assert.equal(isLatticeOwnedConflictPath('STASH_CONFLICT.md'), false);
  assert.equal(isLatticeOwnedConflictPath('STASH_CONFLICT_run.md.bak'), false);
  // Subdirectory match must not slip through.
  assert.equal(isLatticeOwnedConflictPath('sub/STASH_CONFLICT_run.md'), false);
});

test('settings.local.json is in every relevant set', () => {
  // Sanity: editing one constant must not desync the others.
  assert.ok(
    (LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(
      '.claude/settings.local.json',
    ),
  );
  assert.ok(
    (LATTICE_GITIGNORE_ENTRIES as readonly string[]).includes(
      '.claude/settings.local.json',
    ),
  );
  assert.ok(
    (LATTICE_EXCLUDE_PATTERNS as readonly string[]).includes(
      '.claude/settings.local.json',
    ),
  );
});

test('the Pi completion extension is in every relevant set', () => {
  const piExt = '.pi/extensions/lattice-complete.ts';
  assert.ok((LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(piExt));
  assert.ok((LATTICE_GITIGNORE_ENTRIES as readonly string[]).includes(piExt));
  assert.ok((LATTICE_EXCLUDE_PATTERNS as readonly string[]).includes(piExt));
  assert.equal(isLatticeOwnedConflictPath(piExt), true);
  assert.equal(isLatticeOwnedConflictPath('.pi\\extensions\\lattice-complete.ts'), true);
});

test('the pi-subagents loader shim is in every relevant set', () => {
  const shim = '.pi/extensions/lattice-subagents.ts';
  assert.ok((LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(shim));
  assert.ok((LATTICE_GITIGNORE_ENTRIES as readonly string[]).includes(shim));
  assert.ok((LATTICE_EXCLUDE_PATTERNS as readonly string[]).includes(shim));
  assert.equal(isLatticeOwnedConflictPath(shim), true);
  assert.equal(isLatticeOwnedConflictPath('.pi\\extensions\\lattice-subagents.ts'), true);
});

test('the Pi activity extension is in every relevant set', () => {
  const ext = '.pi/extensions/lattice-activity.ts';
  assert.ok((LATTICE_OWNED_FILE_PATHS as readonly string[]).includes(ext));
  assert.ok((LATTICE_GITIGNORE_ENTRIES as readonly string[]).includes(ext));
  assert.ok((LATTICE_EXCLUDE_PATTERNS as readonly string[]).includes(ext));
  assert.equal(isLatticeOwnedConflictPath(ext), true);
});
