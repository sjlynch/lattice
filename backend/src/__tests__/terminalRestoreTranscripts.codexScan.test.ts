// Codex rollout discovery against real rollout files (`session_meta.timestamp`
// is the process start; the rollout file itself appears only on the first
// turn): an incomplete first line (empty, or a truncated session_meta) is
// retried on later scans without clearing shared discovery caches or dropping
// a valid sibling; a thread whose first turn landed after the old 2-minute poll
// is found at relaunch and resumed by id; one started long after the tab
// launched belongs to another tab and is not claimed; discovery backs off
// instead of giving up. Harness: helpers/terminalRestoreTranscripts.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { restoreProjectTerminals } from '../terminalRegistry/restore.js';
import {
  CODEX_FRESH_START_WINDOW_MS,
  discoveryIntervalMs,
  resetCodexDiscoveryCaches,
  scanRecentCodexRollouts,
} from '../terminalRegistry/codexDiscovery.js';
import { deadTab, harness, harnessHome, settle, writeCodexRollout } from './helpers/terminalRestoreTranscripts.js';

for (const { name, initialBody } of [
  { name: 'empty', initialBody: '' },
  { name: 'truncated session_meta', initialBody: '{"type":"session_meta","payload":{"id":"thread-completed","cwd":' },
]) {
  test(`codex scan retries ${name} metadata without clearing caches`, async (t) => {
    resetCodexDiscoveryCaches();
    t.after(() => { resetCodexDiscoveryCaches(); });
    const root = await fs.mkdtemp(path.join(harnessHome, 'codex-incomplete-'));
    t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    const now = Date.parse('2026-09-29T12:00:00.000Z');
    // Keep both scans inside the listing TTL, even on a slow machine.
    t.mock.method(Date, 'now', () => now);
    const dir = path.join(root, '2026', '09', '29');
    await fs.mkdir(dir, { recursive: true });
    const valid = {
      id: 'thread-valid', cwd: root, timestamp: now - 30_000,
      file: path.join(dir, 'rollout-valid.jsonl'), mtimeMs: now,
    };
    const completed = {
      id: 'thread-completed', cwd: root, timestamp: now - 20_000,
      file: path.join(dir, 'rollout-completed.jsonl'), mtimeMs: now,
    };
    const firstLine = (meta: typeof valid) => JSON.stringify({
      type: 'session_meta',
      payload: { id: meta.id, cwd: meta.cwd, timestamp: new Date(meta.timestamp).toISOString() },
    }) + '\n';
    const writtenAt = new Date(now);
    await fs.writeFile(valid.file, firstLine(valid));
    await fs.writeFile(completed.file, initialBody);
    await fs.utimes(valid.file, writtenAt, writtenAt);
    await fs.utimes(completed.file, writtenAt, writtenAt);
    const createdSince = now - 60_000;
    const writtenSince = now - 10_000;

    assert.deepEqual(await scanRecentCodexRollouts(createdSince, root, writtenSince), [valid],
      'incomplete metadata is skipped without discarding the valid sibling');

    // Finish the same file while its listing and the sibling metadata remain
    // cached. Preserve mtime so only the first-line contents have changed.
    await fs.writeFile(completed.file, firstLine(completed));
    await fs.utimes(completed.file, writtenAt, writtenAt);
    assert.deepEqual(await scanRecentCodexRollouts(createdSince, root, writtenSince), [valid, completed],
      'a failed metadata read must not be cached after the file is completed');
  });
}

test('codex: a thread whose first turn landed after the old 2-minute poll is found at relaunch and resumed by id', async () => {
  resetCodexDiscoveryCaches();
  const h = await harness();
  await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' });
  // The process started right after the tab; the file appeared minutes later.
  await writeCodexRollout(h.project, 'thread-late', Date.now() + 1_000);
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, 'codex resume thread-late --yolo');
});

test('codex: a thread started long after the tab launched belongs to another tab and is not claimed', async () => {
  resetCodexDiscoveryCaches();
  const h = await harness();
  await deadTab(h, { initialCommand: 'codex --yolo', harness: 'codex' });
  await writeCodexRollout(h.project, 'someone-elses', Date.now() + CODEX_FRESH_START_WINDOW_MS + 60_000);
  await restoreProjectTerminals(h.project, h.deps);
  await settle(h.spawns);
  assert.equal(h.spawns[0].initialCommand, 'codex resume --last --yolo');
});

test('codex discovery backs off instead of giving up', () => {
  assert.equal(discoveryIntervalMs(0), 2_000);
  assert.equal(discoveryIntervalMs(119_000), 2_000);
  assert.equal(discoveryIntervalMs(5 * 60_000), 15_000);
  assert.equal(discoveryIntervalMs(3 * 60 * 60_000), 60_000);
});
