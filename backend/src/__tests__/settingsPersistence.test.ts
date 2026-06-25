import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { patchUserSettings, getUserSettings } from '../userSettings.js';
import { runExclusive } from '../serializeWrites.js';

// Regression: non-atomic read-modify-write in settings persistence used to lose
// concurrent field updates. patchUserSettings did
// `read -> {...current, ...partial} -> writeFile` with no per-project lock, so
// two patches firing close together (independent React hooks each PATCHing one
// field in response to one interaction) both read the same base and the later
// write clobbered the earlier field. Writes are now serialized per project
// (serializeWrites.ts), so disjoint fields accumulate. The same helper backs
// updateGlobalSettings + setMcpSecret/mergeMcpSecrets.

async function mkProject(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'lattice-settings-'));
}

test('patchUserSettings: two concurrent disjoint patches both survive on disk', async () => {
  const project = await mkProject();
  try {
    // Fire both for the SAME project together. Pre-fix, one of these fields
    // would be silently reverted by the other's write.
    await Promise.all([
      patchUserSettings(project, { sidebarWidth: 321 }),
      patchUserSettings(project, { harness: 'pi' }),
    ]);
    const onDisk = await getUserSettings(project);
    assert.equal(onDisk.sidebarWidth, 321);
    assert.equal(onDisk.harness, 'pi');
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('patchUserSettings: a burst of disjoint patches all survive', async () => {
  const project = await mkProject();
  try {
    await Promise.all([
      patchUserSettings(project, { sidebarWidth: 200 }),
      patchUserSettings(project, { harness: 'claude' }),
      patchUserSettings(project, { piModel: 'vllm/qwen' }),
      patchUserSettings(project, { postMergeHookPrompt: 'lint it' }),
      patchUserSettings(project, { qaTerminalAutoClose: true }),
      patchUserSettings(project, { workflowStepsCollapsed: { s1: true } }),
    ]);
    const onDisk = await getUserSettings(project);
    assert.equal(onDisk.sidebarWidth, 200);
    assert.equal(onDisk.harness, 'claude');
    assert.equal(onDisk.piModel, 'vllm/qwen');
    assert.equal(onDisk.postMergeHookPrompt, 'lint it');
    assert.equal(onDisk.qaTerminalAutoClose, true);
    assert.deepEqual(onDisk.workflowStepsCollapsed, { s1: true });
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
});

test('patchUserSettings: separate projects do not serialize against each other', async () => {
  const [a, b] = await Promise.all([mkProject(), mkProject()]);
  try {
    await Promise.all([
      patchUserSettings(a, { sidebarWidth: 11 }),
      patchUserSettings(b, { sidebarWidth: 22 }),
    ]);
    assert.equal((await getUserSettings(a)).sidebarWidth, 11);
    assert.equal((await getUserSettings(b)).sidebarWidth, 22);
  } finally {
    await fs.rm(a, { recursive: true, force: true });
    await fs.rm(b, { recursive: true, force: true });
  }
});

// ---- runExclusive: the shared per-key mutex backing all three fixes ----

function overlapProbe() {
  let active = 0;
  let maxActive = 0;
  const op = () => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  };
  return { op, max: () => maxActive };
}

test('runExclusive: same key never runs two ops concurrently', async () => {
  const { op, max } = overlapProbe();
  await Promise.all([
    runExclusive('k', op()),
    runExclusive('k', op()),
    runExclusive('k', op()),
  ]);
  assert.equal(max(), 1);
});

test('runExclusive: different keys run concurrently', async () => {
  const { op, max } = overlapProbe();
  await Promise.all([
    runExclusive('a', op()),
    runExclusive('b', op()),
    runExclusive('c', op()),
  ]);
  assert.ok(max() > 1);
});

test('runExclusive: returns each op result and a rejection does not wedge the key', async () => {
  assert.equal(await runExclusive('z', async () => 'first'), 'first');
  await assert.rejects(
    runExclusive('z', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  // A prior failure must not stall later ops on the same key.
  assert.equal(await runExclusive('z', async () => 'after'), 'after');
});
