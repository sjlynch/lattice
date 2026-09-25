import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchParentProcess } from '../terminalServer/parentWatch.js';

// The terminal-server's parent pid is the dev runner that was running when it
// was spawned. A dev soft restart (`r` in the npm run dev console) replaces that
// runner while the server and its agents live on, so the pid is dead for good —
// and Windows recycles pids quickly. A later unrelated process on the same pid
// must not read as "parent back", or an idle, unowned server never exits.

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('once the parent is seen gone, a recycled pid does not stop the shutdown attempts', async () => {
  const alive = [true, false, true, true, true, true, true, true, true, true];
  let probes = 0;
  let attempts = 0;
  let done = false;
  watchParentProcess(
    4242,
    () => {
      attempts++;
      if (attempts >= 3) {
        done = true;
        return true;
      }
      return false;
    },
    2,
    () => alive[Math.min(probes++, alive.length - 1)],
  );
  for (let i = 0; i < 200 && !done; i++) await wait(2);
  assert.equal(done, true);
  assert.equal(attempts, 3);
  // Probed until the first "gone", never again after it.
  assert.equal(probes, 2);
});

test('a live parent never triggers a shutdown attempt', async () => {
  let attempts = 0;
  watchParentProcess(4242, () => { attempts++; return true; }, 2, () => true);
  await wait(30);
  assert.equal(attempts, 0);
});
