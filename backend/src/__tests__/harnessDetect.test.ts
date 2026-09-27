// Regression: harness detection cached a timed-out or failed `where` probe as
// "not installed" for the whole backend lifetime. At boot the probes race tsc,
// the health scan and AV; one slow `where.exe` hid claude/pi/codex from the UI
// (and skipped the Pi sub-agent / Pi MCP installs) until a restart. A
// definitive "not found" (probe exited non-zero) may be cached; a timeout or
// spawn error must not be, and the background re-probe must publish the
// corrected snapshot to listeners (`/ws/harnesses`).

import { afterEach, beforeEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import {
  __setHarnessProbeSpawnForTests,
  detectHarnesses,
  onHarnessAvailabilityChange,
  type HarnessAvailability,
} from '../harnessDetect.js';

type Mode = 'found' | 'missing' | 'hang' | 'spawn-error' | 'throw';

let modes: Record<string, Mode>;
let spawnCount: Record<string, number>;

function installFakeSpawn(): void {
  const fake = (_probe: string, args: readonly string[]) => {
    const cmd = args[0]!;
    spawnCount[cmd] = (spawnCount[cmd] ?? 0) + 1;
    const mode = modes[cmd] ?? 'missing';
    if (mode === 'throw') throw new Error('spawn EPERM');
    const child = Object.assign(new EventEmitter(), { kill: () => true });
    if (mode === 'found' || mode === 'missing') {
      queueMicrotask(() => child.emit('close', mode === 'found' ? 0 : 1));
    } else if (mode === 'spawn-error') {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    }
    // 'hang': never closes — only the probe timeout settles it.
    return child;
  };
  __setHarnessProbeSpawnForTests(fake as unknown as typeof spawn);
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach((t) => {
  // Top-level hooks run around each test, so the context is a TestContext.
  (t as TestContext).mock.timers.enable({ apis: ['setTimeout'] });
  modes = { claude: 'found', pi: 'found', codex: 'found' };
  spawnCount = {};
  installFakeSpawn();
});

afterEach(() => {
  __setHarnessProbeSpawnForTests(null);
});

test('a timed-out probe reports unavailable but is re-probed on the next call', async (t) => {
  modes.pi = 'hang';
  const first = detectHarnesses();
  // Let the non-hanging probes close before the probe timeout fires.
  await flush();
  t.mock.timers.tick(5000);
  assert.deepEqual(await first, { claude: true, pi: false, codex: true });

  modes.pi = 'found';
  assert.deepEqual(await detectHarnesses(), { claude: true, pi: true, codex: true });
  assert.equal(spawnCount.pi, 2);

  // Now definitive: cached, no further probes.
  await detectHarnesses();
  assert.equal(spawnCount.pi, 2);
});

test('a probe exiting non-zero is a definitive "not found" and stays cached', async () => {
  modes.codex = 'missing';
  assert.deepEqual(await detectHarnesses(), { claude: true, pi: true, codex: false });
  modes.codex = 'found';
  assert.deepEqual(await detectHarnesses(), { claude: true, pi: true, codex: false });
  assert.equal(spawnCount.codex, 1);
});

test('spawn errors (async or thrown) are not cached', async () => {
  modes.claude = 'spawn-error';
  modes.pi = 'throw';
  assert.deepEqual(await detectHarnesses(), { claude: false, pi: false, codex: true });
  modes.claude = 'found';
  modes.pi = 'found';
  assert.deepEqual(await detectHarnesses(), { claude: true, pi: true, codex: true });
});

test('concurrent callers share one in-flight probe', async () => {
  const [a, b] = await Promise.all([detectHarnesses(), detectHarnesses()]);
  assert.deepEqual(a, b);
  assert.equal(spawnCount.claude, 1);
});

test('the background re-probe publishes the corrected snapshot to listeners', async (t) => {
  modes.pi = 'hang';
  const first = detectHarnesses();
  // Let the non-hanging probes close before the probe timeout fires.
  await flush();
  t.mock.timers.tick(5000);
  assert.equal((await first).pi, false);

  const seen: HarnessAvailability[] = [];
  onHarnessAvailabilityChange((avail) => seen.push(avail));
  modes.pi = 'found';
  t.mock.timers.tick(5000); // background re-probe delay
  await flush();
  assert.deepEqual(seen, [{ claude: true, pi: true, codex: true }]);
});
