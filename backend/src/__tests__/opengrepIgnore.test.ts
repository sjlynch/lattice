import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addOpengrepIgnores } from '../opengrep/service.js';
import { getUserSettings, patchUserSettings } from '../userSettings.js';

// `addOpengrepIgnores` is the one Lattice-settings write a planning agent may
// make (via `opengrep_ignore` / `POST /api/opengrep/ignore`): rule noise
// becomes a per-project setting instead of a "please ignore X" ticket. Pinned:
// additive + deduplicated, the `opengrep:<fp>` task-marker spelling is
// accepted, other Opengrep settings on the project survive, and a no-op call
// writes nothing.

async function withProject<T>(fn: (project: string) => Promise<T>): Promise<T> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-opengrep-ignore-'));
  try {
    return await fn(project);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
}

test('appends rule ids and fingerprints, deduplicates, keeps the rest of the project settings', async () => {
  await withProject(async (project) => {
    await patchUserSettings(project, { opengrep: { severityFloor: 'INFO', ignoreRuleIds: ['already'] } });

    const first = await addOpengrepIgnores(project, {
      ruleIds: ['i18next-key-format', ' already ', ''],
      fingerprints: ['opengrep:62da25210dcc0ac0_0', 'b17b2c77d6ca6416_0'],
    });
    assert.deepEqual(first.added, {
      ruleIds: ['i18next-key-format'],
      fingerprints: ['62da25210dcc0ac0_0', 'b17b2c77d6ca6416_0'],
    });
    assert.deepEqual(first.ignoreRuleIds, ['already', 'i18next-key-format']);
    assert.deepEqual(first.ignoreFingerprints, ['62da25210dcc0ac0_0', 'b17b2c77d6ca6416_0']);

    const saved = (await getUserSettings(project)).opengrep!;
    assert.equal(saved.severityFloor, 'INFO', 'unrelated Opengrep settings survive');
    assert.deepEqual(saved.ignoreRuleIds, ['already', 'i18next-key-format']);

    const again = await addOpengrepIgnores(project, { ruleIds: ['i18next-key-format'] });
    assert.deepEqual(again.added, { ruleIds: [], fingerprints: [] });
    assert.deepEqual(again.ignoreRuleIds, ['already', 'i18next-key-format']);
  });
});

test('a call that adds nothing does not create a settings file', async () => {
  await withProject(async (project) => {
    const r = await addOpengrepIgnores(project, { ruleIds: [], fingerprints: [7 as unknown as string] });
    assert.deepEqual(r.added, { ruleIds: [], fingerprints: [] });
    await assert.rejects(fs.access(path.join(project, '.lattice', 'userSettings.json')));
  });
});
