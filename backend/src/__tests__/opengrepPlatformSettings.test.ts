import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOpengrepAsset } from '../opengrep/platform.js';
import {
  effectiveOpengrepConfig,
  enabledPackIds,
  sanitizeOpengrepGlobalSettings,
  sanitizeOpengrepProjectSettings,
} from '../opengrep/settings.js';
import { OPENGREP_ASSETS, OPENGREP_RULE_PACKS, OPENGREP_VERSION } from '../opengrep/versions.js';

// The user never picks a platform: the asset comes from platform/arch (+ musl).
test('pickOpengrepAsset covers every published build and falls back sensibly', () => {
  const pick = (platform: string, arch: string, musl = false) =>
    pickOpengrepAsset({ platform, arch, musl });
  assert.equal(pick('win32', 'x64')?.asset, 'opengrep_windows_x86.exe');
  const winArm = pick('win32', 'arm64');
  assert.equal(winArm?.asset, 'opengrep_windows_x86.exe');
  assert.match(winArm?.note ?? '', /emulation/);
  assert.equal(pick('linux', 'x64')?.asset, 'opengrep_manylinux_x86');
  assert.equal(pick('linux', 'x64', true)?.asset, 'opengrep_musllinux_x86');
  assert.equal(pick('linux', 'arm64')?.asset, 'opengrep_manylinux_aarch64');
  assert.equal(pick('linux', 'arm64', true)?.asset, 'opengrep_musllinux_aarch64');
  assert.equal(pick('darwin', 'arm64')?.asset, 'opengrep_osx_arm64');
  assert.equal(pick('darwin', 'x64')?.asset, 'opengrep_osx_x86');
  assert.equal(pick('linux', 'ia32'), null);
  assert.equal(pick('freebsd', 'x64'), null);
  assert.equal(pick('sunos', 'x64'), null);
});

test('every asset the picker can choose has a verified pin', () => {
  for (const [name, pin] of Object.entries(OPENGREP_ASSETS)) {
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, `${name} has a SHA-256 pin`);
    assert.ok(pin.bytes > 10_000_000, `${name} pinned size looks like a real binary (${pin.bytes})`);
  }
  assert.match(OPENGREP_VERSION, /^\d+\.\d+\.\d+$/);
});

test('rule-pack catalog: both packs used once installed, every pack pinned to a full commit, licences stated', () => {
  assert.equal(OPENGREP_RULE_PACKS.filter((p) => p.defaultEnabled).length, 2);
  for (const p of OPENGREP_RULE_PACKS) {
    assert.match(p.commit, /^[0-9a-f]{40}$/, `${p.id} pinned by full commit`);
    assert.match(p.repo, /^https:\/\/github\.com\/.+\.git$/);
    assert.ok(p.licence.length > 0 && p.note.length > 20, `${p.id} carries licence + note`);
  }
  const archived = OPENGREP_RULE_PACKS.find((p) => p.id === 'opengrep-archived')!;
  // Used once installed (it is the only real TS/Node coverage); the licence
  // condition is carried on the row so the INSTALL click stays informed.
  assert.equal(archived.defaultEnabled, true, 'the archived pack is used as soon as it is installed');
  assert.match(archived.licence, /Commons Clause/);
  assert.match(archived.note, /Commons Clause/);
  const qodana = OPENGREP_RULE_PACKS.find((p) => p.id === 'qodana-mit')!;
  assert.ok(qodana.prune.includes('jetbrains') && qodana.prune.includes('rules/lgpl'));
});

test('enabledPackIds: defaults, overrides in both directions, unknown ids ignored', () => {
  assert.deepEqual(enabledPackIds(undefined), ['qodana-mit', 'opengrep-archived']);
  assert.deepEqual(enabledPackIds({ packs: { 'qodana-mit': false, 'opengrep-archived': false } }), []);
  assert.deepEqual(
    enabledPackIds({ packs: { 'qodana-mit': false, 'opengrep-archived': true } }),
    ['opengrep-archived'],
  );
  assert.deepEqual(enabledPackIds({ packs: { 'opengrep-archived': false } }), ['qodana-mit']);
  assert.deepEqual(enabledPackIds({ packs: { bogus: true } }), ['qodana-mit', 'opengrep-archived']);
  assert.deepEqual(sanitizeOpengrepGlobalSettings({ packs: { bogus: true, 'qodana-mit': 'yes' } }), {
    packs: {},
  });
  assert.deepEqual(sanitizeOpengrepGlobalSettings('junk'), {});
});

test('project settings are sanitized on read: severity case-folds, junk degrades to defaults, budget clamps', () => {
  assert.deepEqual(sanitizeOpengrepProjectSettings(null), {});
  assert.deepEqual(
    sanitizeOpengrepProjectSettings({
      severityFloor: 'error',
      ignoreRuleIds: ['a', ' b ', 'a', 7, ''],
      ignoreFingerprints: 'nope',
      extraRulePaths: ['rules/x'],
      excludeGlobs: ['gen/**'],
      digestBudgetKb: 99999,
    }),
    {
      severityFloor: 'ERROR',
      ignoreRuleIds: ['a', 'b'],
      ignoreFingerprints: [],
      extraRulePaths: ['rules/x'],
      excludeGlobs: ['gen/**'],
      digestBudgetKb: 2048,
    },
  );
  assert.deepEqual(sanitizeOpengrepProjectSettings({ severityFloor: 'LOUD', digestBudgetKb: 1 }), {});
  assert.deepEqual(
    sanitizeOpengrepProjectSettings({ ignoreFingerprints: ['opengrep:abcdef0123456789_0', 'abcdef0123456789_0', 'opengrep:', 'OPENGREP:ffff0000ffff0000_1'] }),
    { ignoreFingerprints: ['abcdef0123456789_0', 'ffff0000ffff0000_1'] },
    'the task-marker prefix is stripped and the list deduplicated',
  );

  const cfg = effectiveOpengrepConfig(undefined, undefined);
  assert.deepEqual(cfg, {
    packIds: ['qodana-mit', 'opengrep-archived'],
    extraRulePaths: [],
    excludeGlobs: [],
    filter: { severityFloor: 'WARNING', ignoreRuleIds: [], ignoreFingerprints: [] },
    budgetBytes: 60 * 1024,
  });
  assert.equal(
    effectiveOpengrepConfig(undefined, { severityFloor: 'INFO', digestBudgetKb: 100 }).budgetBytes,
    100 * 1024,
  );
});
