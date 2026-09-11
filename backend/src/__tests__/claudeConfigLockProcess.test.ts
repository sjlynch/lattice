import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { withClaudeConfigLock } from '../claudeTrust/configLock.js';
import { withTempDir } from './helpers/tempDir.js';

test('a real live config writer remains exclusive and its abandoned lock recovers after process death', { timeout: 30_000 }, async () => {
  await withTempDir('lattice-config-lock-process-', async (dir) => {
    const lockPath = path.join(dir, 'lock');
    const fixture = path.join(dir, 'owner.mjs');
    const moduleUrl = new URL('../claudeTrust/configLock.ts', import.meta.url).href;
    await fs.writeFile(fixture, `
      import { withClaudeConfigLock } from ${JSON.stringify(moduleUrl)};
      await withClaudeConfigLock(async () => {
        process.stdout.write('holding-lock\\n');
        await new Promise(() => { setInterval(() => {}, 1000); });
      }, { lockDir: process.argv[2] });
    `);
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, lockPath], {
      cwd: path.resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    try {
      const deadline = Date.now() + 15_000;
      while (!output.includes('holding-lock\n')) {
        assert.ok(Date.now() < deadline && child.exitCode === null, `fixture did not acquire lock: ${output}`);
        await delay(20);
      }
      const original = await fs.readFile(lockPath, 'utf8');
      assert.equal(JSON.parse(original).pid, child.pid);
      let entered = false;
      const fast = { lockDir: lockPath, retryDelays: [1, 1], stealRetryDelays: [1, 1], operationRetryDelays: [1] };
      await assert.rejects(withClaudeConfigLock(async () => { entered = true; }, fast), /could not acquire/);
      assert.equal(entered, false);
      assert.equal(await fs.readFile(lockPath, 'utf8'), original, 'waiting must not remove a slow live writer');

      // Kill only the fixture child we just spawned, preserving its lock as a
      // real interrupted writer would. No Lattice server or terminal is used.
      child.kill();
      await closed;
      const result = await withClaudeConfigLock(async () => {
        const replacement = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        assert.equal(replacement.pid, process.pid);
        assert.notEqual(replacement.ownerId, JSON.parse(original).ownerId);
        return 'recovered';
      }, fast);
      assert.equal(result, 'recovered');
      await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
      assert.equal((await fs.readdir(`${lockPath}.retired`)).length, 1, 'only dead-owner retirement leaves a generation claim');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }
  });
});
