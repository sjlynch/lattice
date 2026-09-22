import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { patchUserSettings, getUserSettings } from '../userSettings.js';
import { getGlobalSettings, updateGlobalSettings, updateGlobalSettingsWith } from '../globalSettings.js';
import { latticeHomeDir } from '../projectPath.js';
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

for (const scope of ['project', 'global'] as const) {
  async function fixture() {
    const project = await mkProject();
    const file = scope === 'project'
      ? path.join(project, '.lattice', 'userSettings.json')
      : path.join(latticeHomeDir(), 'globalSettings.json');
    const patch = () => scope === 'project'
      ? patchUserSettings(project, { sidebarWidth: 321 })
      : updateGlobalSettings({ maxConcurrentAgents: 2 });
    const read = () => scope === 'project' ? getUserSettings(project) : getGlobalSettings();
    await fs.mkdir(path.dirname(file), { recursive: true });
    return { project, file, patch, read };
  }

  test(`${scope} settings: failed reads cannot turn a partial patch into a settings reset`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.project, { recursive: true, force: true }));
    const previous = JSON.stringify({ piModelMenu: ['provider/keep'], postMergeHookPrompt: 'keep this' });
    await fs.writeFile(f.file, previous, 'utf8');
    const readFile = fs.readFile;
    let unavailable = true;
    t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === f.file && unavailable) {
        throw Object.assign(new Error('locked'), { code: 'EACCES' });
      }
      return readFile(...args);
    });
    // Display-only reads retain the historical defaults fallback.
    await f.read();
    await assert.rejects(f.patch(), { code: 'EACCES' });
    unavailable = false;
    assert.equal(await readFile(f.file, 'utf8'), previous);
    await f.patch();
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(scope === 'project' ? saved.postMergeHookPrompt : saved.piModelMenu[0],
      scope === 'project' ? 'keep this' : 'provider/keep');
  });

  test(`${scope} settings: a corrupt file remains recoverable after a rejected patch`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.project, { recursive: true, force: true }));
    const previous = '{"postMergeHookPrompt":"unfinished';
    await fs.writeFile(f.file, previous, 'utf8');
    await f.read();
    await assert.rejects(f.patch(), SyntaxError);
    assert.equal(await fs.readFile(f.file, 'utf8'), previous);
  });

  test(`${scope} settings: valid JSON that is not an object is never replaced by a patch`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.project, { recursive: true, force: true }));
    for (const previous of ['[{"postMergeHookPrompt":"keep"}]', 'null']) {
      await fs.writeFile(f.file, previous, 'utf8');
      await f.read(); // display reads still fall back to defaults
      await assert.rejects(f.patch(), /does not hold a settings object/);
      assert.equal(await fs.readFile(f.file, 'utf8'), previous);
    }
  });

  test(`${scope} settings: a partial write failure preserves the complete previous file`, async (t) => {
    const f = await fixture();
    t.after(() => fs.rm(f.project, { recursive: true, force: true }));
    const previous = '{"maxConcurrentAgents":3,"postMergeHookPrompt":"keep"}';
    await fs.writeFile(f.file, previous, 'utf8');
    const writeFile = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).startsWith(f.file)) {
        await writeFile(args[0], '{"truncated', 'utf8');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return writeFile(...args);
    });
    await assert.rejects(f.patch(), { code: 'ENOSPC' });
    assert.equal(await fs.readFile(f.file, 'utf8'), previous);
  });
}

// A caller that derives its patch from an earlier (unlocked) read wrote that
// stale snapshot back over a save that landed in between (Pi auto-discovery,
// MCP config import). updateGlobalSettingsWith computes the patch from the
// value read INSIDE the lock, so the interleaved save survives.
test('updateGlobalSettingsWith: the updater sees a save queued ahead of it', async () => {
  await updateGlobalSettings({ piModelMenu: [] });
  const save = updateGlobalSettings({ piModelMenu: ['a/saved'] });
  const derived = updateGlobalSettingsWith((cur) => ({
    piModelMenu: [...(cur.piModelMenu ?? []), 'b/derived'],
  }));
  await Promise.all([save, derived]);
  assert.deepEqual((await getGlobalSettings()).piModelMenu, ['a/saved', 'b/derived']);
  // A null patch skips the write entirely.
  const file = path.join(latticeHomeDir(), 'globalSettings.json');
  const before = await fs.readFile(file, 'utf8');
  await updateGlobalSettingsWith(() => null);
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
