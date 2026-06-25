import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  harnessUnavailable,
  loadHarnessForFolder,
} from '../components/taskboard/hooks/harnessSelectorLoad.ts';
import type { HarnessAvailability, HarnessChoice } from '../harnesses.ts';
import type { UserSettings } from '../api';

const PI_OFF: HarnessAvailability = { claude: true, pi: false, codex: false };
const PI_ON: HarnessAvailability = { claude: true, pi: true, codex: true };

// Mirrors the hook's monotonic load-id ref: a load applies only if it's still
// the latest one.
function makeRecorder() {
  const harness: HarnessChoice[] = [];
  const piModel: (string | undefined)[] = [];
  const patches: Array<{ folder: string; partial: Partial<UserSettings> }> = [];
  return {
    harness,
    piModel,
    patches,
    setHarness: (h: HarnessChoice) => harness.push(h),
    setPiModel: (m: string | undefined) => piModel.push(m),
    patchUserSettings: (folder: string, partial: Partial<UserSettings>) => {
      patches.push({ folder, partial });
      return Promise.resolve({});
    },
  };
}

test('harnessUnavailable: pi/interleave need pi, codex needs codex', () => {
  assert.equal(harnessUnavailable('pi', PI_OFF), true);
  assert.equal(harnessUnavailable('interleave', PI_OFF), true);
  assert.equal(harnessUnavailable('codex', PI_OFF), true);
  assert.equal(harnessUnavailable('claude', PI_OFF), false);
  assert.equal(harnessUnavailable('pi', PI_ON), false);
  assert.equal(harnessUnavailable('codex', PI_ON), false);
});

// The core regression for the fast-project-switch bug: project A's settings
// fetch resolves AFTER the user has already switched to project B. The stale A
// response must not overwrite B's selection, and must not persist a coerced
// `harness: claude` patch under A.
test('a slow project-A load resolving after switching to B leaves B selected and sends no stale patch', async () => {
  const seqRef = { current: 0 };
  const rec = makeRecorder();

  let resolveA!: (s: UserSettings) => void;
  const aPending = new Promise<UserSettings>((res) => {
    resolveA = res;
  });
  const fetchUserSettings = (folder: string): Promise<UserSettings> => {
    if (folder === 'A') return aPending;
    if (folder === 'B') return Promise.resolve({ harness: 'claude' });
    return Promise.resolve({});
  };

  const depsFor = (seq: number) => ({
    fetchUserSettings,
    patchUserSettings: rec.patchUserSettings,
    isStale: () => seqRef.current !== seq,
    setHarness: rec.setHarness,
    setPiModel: rec.setPiModel,
  });

  // Folder A load starts (seq 1) — its fetch is still pending.
  const seqA = ++seqRef.current;
  const loadA = loadHarnessForFolder('A', PI_OFF, depsFor(seqA));

  // User switches to B before A resolves (seq 2). B resolves immediately.
  const seqB = ++seqRef.current;
  await loadHarnessForFolder('B', PI_OFF, depsFor(seqB));

  // B applied: claude selected, B's (empty) Pi model cleared.
  assert.deepEqual(rec.harness, ['claude']);
  assert.deepEqual(rec.piModel, [undefined]);

  // The slow A response now arrives. A saved `pi` while pi is unavailable WOULD
  // coerce to claude and patch — but A is stale, so nothing happens.
  resolveA({ harness: 'pi', piModel: 'vllm/qwen' });
  await loadA;

  assert.deepEqual(rec.harness, ['claude'], 'stale A must not change the selection');
  assert.deepEqual(rec.piModel, [undefined], 'stale A must not set a Pi model');
  assert.equal(rec.patches.length, 0, 'stale A must not persist a coerced patch');
});

test('the latest (non-stale) load applies its harness + Pi model', async () => {
  const seqRef = { current: 0 };
  const rec = makeRecorder();
  const seq = ++seqRef.current;
  await loadHarnessForFolder('B', PI_ON, {
    fetchUserSettings: () => Promise.resolve({ harness: 'pi', piModel: 'vllm/qwen' }),
    patchUserSettings: rec.patchUserSettings,
    isStale: () => seqRef.current !== seq,
    setHarness: rec.setHarness,
    setPiModel: rec.setPiModel,
  });
  assert.deepEqual(rec.harness, ['pi']);
  assert.deepEqual(rec.piModel, ['vllm/qwen']);
  assert.equal(rec.patches.length, 0, 'an available harness needs no coercion patch');
});

test('a current load with an unavailable saved harness coerces to claude and patches that folder', async () => {
  const seqRef = { current: 0 };
  const rec = makeRecorder();
  const seq = ++seqRef.current;
  await loadHarnessForFolder('proj', PI_OFF, {
    fetchUserSettings: () => Promise.resolve({ harness: 'pi' }),
    patchUserSettings: rec.patchUserSettings,
    isStale: () => seqRef.current !== seq,
    setHarness: rec.setHarness,
    setPiModel: rec.setPiModel,
  });
  assert.deepEqual(rec.harness, ['claude']);
  assert.deepEqual(rec.patches, [{ folder: 'proj', partial: { harness: 'claude' } }]);
});
