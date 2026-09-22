// Regressions for Opengrep state/settings writes that could lose data, plus
// the absolute-path drill-down:
//  - a pack install's stale-dir sweep deleted a DIFFERENT pack's in-flight
//    `.tmp-*` fetch dir (or its moved-aside `.old-*` tree mid-swap);
//  - updateOpengrepState built the next state on a lenient `{}` read of an
//    unreadable state.json, dropping `binary` and every other pack's record;
//  - addOpengrepIgnores read settings leniently outside the settings lock and
//    patched its snapshot back, overwriting a concurrent Settings save;
//  - `file=<absolute path>` matched no finding and reported "nothing to triage".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sweepStalePackDirs } from '../opengrep/rules.js';
import { readOpengrepState, updateOpengrepState } from '../opengrep/state.js';
import { stateFilePath } from '../opengrep/paths.js';
import { addOpengrepIgnores, digestFor } from '../opengrep/service.js';
import { effectiveOpengrepConfig } from '../opengrep/settings.js';
import type { OpengrepScanRecord } from '../opengrep/scan.js';
import type { ParsedOpengrepOutput } from '../opengrep/digest.js';
import { getUserSettings, patchUserSettings } from '../userSettings.js';

if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error('opengrepStateSafety.test.ts writes under ~/.lattice — run with the isolateHome preload');
}

test('a pack install sweeps only its own stale dirs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-og-rules-'));
  try {
    const names = [
      '.tmp-qodana-mit-123-456', // own leftover
      '.old-qodana-mit-789', // own leftover
      '.tmp-opengrep-archived-123-456', // a sibling install in flight
      '.old-opengrep-archived-789', // a sibling mid-swap
      '.tmp-qodana-mit-extra-1-2', // a pack whose id merely starts with ours
      'qodana-mit', // the installed pack itself
    ];
    for (const n of names) await fs.mkdir(path.join(root, n));
    await sweepStalePackDirs(root, 'qodana-mit');
    assert.deepEqual((await fs.readdir(root)).sort(), [
      '.old-opengrep-archived-789',
      '.tmp-opengrep-archived-123-456',
      '.tmp-qodana-mit-extra-1-2',
      'qodana-mit',
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('updateOpengrepState refuses to build on an unreadable state.json', async () => {
  const file = stateFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const corrupt = '{"binary":{"version":"1.0.0"},"packs":{"a":{"commit":"x"';
  await fs.writeFile(file, corrupt);
  try {
    // Display reads stay lenient…
    assert.deepEqual(await readOpengrepState(), { packs: {} });
    // …but a write must not replace the file with `{packs:{b}}`.
    await assert.rejects(
      updateOpengrepState((s) => ({ ...s, packs: { ...s.packs, b: { commit: 'y' } as never } })),
      /refusing to overwrite/,
    );
    assert.equal(await fs.readFile(file, 'utf8'), corrupt);
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('addOpengrepIgnores merges into the settings as they are inside the lock', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-og-ignore-race-'));
  try {
    await patchUserSettings(project, { opengrep: { severityFloor: 'WARNING' } });
    // A Settings save queued ahead of the ignore call must survive it.
    await Promise.all([
      patchUserSettings(project, { opengrep: { severityFloor: 'INFO', excludeGlobs: ['dist/**'] } }),
      addOpengrepIgnores(project, { ruleIds: ['noisy-rule'] }),
    ]);
    const saved = (await getUserSettings(project)).opengrep!;
    assert.equal(saved.severityFloor, 'INFO');
    assert.deepEqual(saved.excludeGlobs, ['dist/**']);
    assert.deepEqual(saved.ignoreRuleIds, ['noisy-rule']);

    // An unreadable settings file is refused, not read as `{}` and replaced.
    const file = path.join(project, '.lattice', 'userSettings.json');
    await fs.writeFile(file, '{"opengrep":');
    await assert.rejects(addOpengrepIgnores(project, { ruleIds: ['x'] }));
    assert.equal(await fs.readFile(file, 'utf8'), '{"opengrep":');
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('digest drill-down accepts an absolute file path inside the project', () => {
  const project = path.resolve(os.tmpdir(), 'og-proj');
  const parsed: ParsedOpengrepOutput = {
    version: '1',
    findings: [
      {
        fingerprint: 'f'.repeat(32) + '_0',
        shortFingerprint: 'ffffffffffffffff_0',
        ruleId: 'r.one',
        severity: 'ERROR',
        message: 'm',
        path: 'src/a.ts',
        line: 1,
        endLine: 1,
        col: 1,
        snippet: 'x',
        cwe: [],
        references: [],
      },
    ],
    errors: [],
    partiallyParsed: [],
    scannedFiles: 1,
    skippedRules: 0,
  };
  const record = { id: 'og_1', project, startedAt: 0 } as unknown as OpengrepScanRecord;
  const config = effectiveOpengrepConfig(undefined, undefined);
  const { digest } = digestFor(parsed, record, config, { file: path.join(project, 'src', 'a.ts') });
  assert.equal(digest.groups.length, 1);
});
