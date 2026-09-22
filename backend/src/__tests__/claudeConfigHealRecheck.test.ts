// Regressions: two ~/.claude.json heal paths restored the (up to a minute
// old) backup over a live, newer config.
//  - The per-spawn read healed on a SINGLE failed parse, but Claude rewrites
//    the file in place, so a read can land mid-write.
//  - The guard decided "corrupt" before taking the config lock and restored
//    after acquiring it without re-checking, over a valid file written in
//    between.
// Writes the (isolated) home's ~/.claude.json + backup; never a real home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CLAUDE_GLOBAL_CONFIG,
  CLAUDE_JSON_BACKUP,
  readClaudeConfig,
  restoreClaudeConfigFromBackup,
} from '../claudeTrust/configFile.js';
import { withClaudeConfigLock } from '../claudeTrust/configLock.js';

if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error('claudeConfigHealRecheck.test.ts writes ~/.claude.json — run with the isolateHome preload');
}

const LIVE = JSON.stringify({ projects: { 'C:/new': { hasTrustDialogAccepted: true } } });
const BACKUP = JSON.stringify({ projects: { 'C:/old': {} } });

async function seed(live: string): Promise<void> {
  await fs.mkdir(path.dirname(CLAUDE_JSON_BACKUP), { recursive: true });
  await fs.writeFile(CLAUDE_JSON_BACKUP, BACKUP);
  await fs.writeFile(CLAUDE_GLOBAL_CONFIG, live);
}

test('a read that lands mid-write is re-read, not healed from the stale backup', async () => {
  await seed(LIVE.slice(0, 20)); // Claude is part-way through its rewrite
  // …and finishes it shortly after.
  const finish = new Promise<void>((resolve) =>
    setTimeout(() => void fs.writeFile(CLAUDE_GLOBAL_CONFIG, LIVE).then(() => resolve()), 50),
  );
  const cfg = await withClaudeConfigLock(() => readClaudeConfig());
  await finish;
  assert.deepEqual(cfg, JSON.parse(LIVE));
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), LIVE);
});

test('a file that stays corrupt is still healed from the backup', async () => {
  await seed('{"projects": {');
  const cfg = await withClaudeConfigLock(() => readClaudeConfig());
  assert.deepEqual(cfg, JSON.parse(BACKUP));
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), BACKUP);
});

test('the guard re-checks inside the lock and leaves a now-valid file alone', async () => {
  await seed(LIVE);
  assert.equal(await restoreClaudeConfigFromBackup(), 'healthy');
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), LIVE);

  await fs.writeFile(CLAUDE_GLOBAL_CONFIG, '{"trunc');
  assert.equal(await restoreClaudeConfigFromBackup(), 'restored');
  assert.equal(await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8'), BACKUP);
});
