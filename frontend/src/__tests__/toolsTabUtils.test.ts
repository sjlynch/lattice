import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_DRAFT,
  describeScan,
  draftFromSettings,
  formatBytes,
  lines,
  needsLicenceAcknowledgement,
  settingsFromDraft,
} from '../components/settings/tools/toolsTabUtils.ts';
import type { OpengrepScanRecord } from '../api';

test('lines trims, drops blanks and dedupes across CRLF/LF', () => {
  assert.deepEqual(lines(' a \r\nb\n\n a\n  \nc'), ['a', 'b', 'c']);
  assert.deepEqual(lines(''), []);
});

test('draftFromSettings of nothing is the empty draft', () => {
  assert.deepEqual(draftFromSettings(undefined), EMPTY_DRAFT);
});

test('settingsFromDraft round-trips lists and clamps the digest budget', () => {
  const draft = draftFromSettings({
    severityFloor: 'ERROR',
    ignoreRuleIds: ['r1', 'r2'],
    ignoreFingerprints: ['fp'],
    extraRulePaths: [],
    excludeGlobs: ['dist/**'],
    digestBudgetKb: 120,
  });
  assert.deepEqual(settingsFromDraft(draft), {
    severityFloor: 'ERROR',
    ignoreRuleIds: ['r1', 'r2'],
    ignoreFingerprints: ['fp'],
    extraRulePaths: [],
    excludeGlobs: ['dist/**'],
    digestBudgetKb: 120,
  });
  assert.equal(settingsFromDraft({ ...EMPTY_DRAFT, digestBudgetKb: '4' }).digestBudgetKb, 60);
  assert.equal(settingsFromDraft({ ...EMPTY_DRAFT, digestBudgetKb: 'x' }).digestBudgetKb, 60);
  assert.equal(settingsFromDraft({ ...EMPTY_DRAFT, digestBudgetKb: '99999' }).digestBudgetKb, 2048);
  assert.equal(settingsFromDraft({ ...EMPTY_DRAFT, digestBudgetKb: '12.7' }).digestBudgetKb, 12);
});

test('formatBytes picks B / KB / MB', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

test('needsLicenceAcknowledgement flags the Commons Clause only', () => {
  assert.equal(needsLicenceAcknowledgement('LGPL-2.1 + Commons Clause'), true);
  assert.equal(needsLicenceAcknowledgement('MIT'), false);
});

test('describeScan summarizes counts, duration and packs', () => {
  const s = {
    findings: 1,
    bySeverity: { ERROR: 1, WARNING: 0, INFO: 0 },
    scannedFiles: 10,
    durationMs: 2400,
    packIds: [],
  } as unknown as OpengrepScanRecord;
  assert.equal(
    describeScan(s),
    '1 finding (1 ERROR / 0 WARNING / 0 INFO) in 10 files, 2s, project rules only',
  );
  assert.match(describeScan({ ...s, findings: 3, packIds: ['a', 'b'] }), /^3 findings .* a \+ b$/);
});
