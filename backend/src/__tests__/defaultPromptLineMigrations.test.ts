// Task agents no longer run tests or type-checks (a workflow's Run tests step
// verifies merged work), so the built-in workflow prompts stopped asking for
// them. Two places carried the old wording into SAVED workflows: the refactor
// quick-add body (a prefix migration) and a guidance bullet in the "## Active
// project tailoring" suffix, which the prefix migrations keep verbatim — so the
// bullet has its own whole-line migration, pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROMPT_LINE_MIGRATIONS,
  DEFAULT_PROMPT_MIGRATIONS,
  migrateDefaultPromptText,
} from '../workflows/defaultPromptMigrations.js';

const refactor = DEFAULT_PROMPT_MIGRATIONS.find((m) => m.id === 'quick-add:refactor')!;
const bullet = DEFAULT_PROMPT_LINE_MIGRATIONS[0];

const tailoring = (line: string) =>
  [
    '',
    '',
    '{{user_instructions}}',
    '',
    '## Active project tailoring',
    '',
    'This active project appears to be TypeScript + Node.js. Tailor the refactor workflow to C:\\proj.',
    '',
    '- For TypeScript code, preserve strict type safety.',
    line,
  ].join('\n');

test('a saved refactor prompt with the type-check requirement is upgraded, suffix and all', () => {
  const saved = refactor.legacy[0] + tailoring(bullet.legacy);
  const migrated = migrateDefaultPromptText(saved);
  assert.equal(migrated, refactor.current + tailoring(bullet.current));
  assert.doesNotMatch(migrated, /type-check before it is committed|targeted tests/);
  // Idempotent.
  assert.equal(migrateDefaultPromptText(migrated), migrated);
});

test('the new refactor body is not a prefix of the old one (else the old tail would survive)', () => {
  assert.ok(!refactor.legacy[0].startsWith(refactor.current));
  assert.match(refactor.legacy[0], /must type-check before it is committed/);
});

test('the stale tailoring bullet is reworded in any prompt, CRLF included', () => {
  const custom = `My own step prompt.\r\n\r\n${bullet.legacy}\r\n- Another bullet.`;
  assert.equal(
    migrateDefaultPromptText(custom),
    `My own step prompt.\n\n${bullet.current}\n- Another bullet.`,
  );
});

test('a prompt without stale text comes back byte-identical', () => {
  const text = `Custom.\r\n${bullet.current}`;
  assert.equal(migrateDefaultPromptText(text), text);
  // Only an exact line matches: a bullet the user extended is theirs.
  const edited = `${bullet.legacy} Also lint.`;
  assert.equal(migrateDefaultPromptText(edited), edited);
});

test('the current bullet matches the frontend stack guidance', () => {
  const file = fileURLToPath(
    new URL('../../../frontend/src/components/workflows/projectStackDetection.ts', import.meta.url),
  );
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(`'${bullet.current.slice(2)}'`), 'projectStackDetection.ts drifted from the line migration');
  assert.ok(!source.includes(bullet.legacy.slice(2)));
});
