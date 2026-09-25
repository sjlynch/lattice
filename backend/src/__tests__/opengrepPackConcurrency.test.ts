// Rule-pack install / remove / scan overlap (opengrep/rulesGate.ts). The
// failures this pins, all from requests that were each fine on their own:
//   - Remove during an install's fetch used to be undone when the install
//     renamed its tree into place and rewrote the state entry.
//   - A scan starting mid-install could run while the swap renamed the pack
//     out from under the engine (a digest silently missing the pack, or EBUSY
//     on Windows); the route only checked for running scans at request time.
// The git fetch and the engine are fakes at their seams, so every overlap is
// driven deterministically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { getRulePackJob, installRulePack, isRulePackInstalling, removeRulePack } from '../opengrep/rules.js';
import { OpengrepRulesBusyError, isRulesMutationPending } from '../opengrep/rulesGate.js';
import { runOpengrepScan } from '../opengrep/scan.js';
import { rulePackDir, rulesRootDir } from '../opengrep/paths.js';
import { readOpengrepState } from '../opengrep/state.js';
import { buildOpengrepRouter } from '../routes/opengrep.js';
import type { SpawnWithTimeoutResult } from '../spawnWithTimeout.js';

if (!process.env.LATTICE_TEST_HOME_ISOLATED) {
  throw new Error(
    'opengrepPackConcurrency.test.ts writes under ~/.lattice — run it via `npm test` (or with ' +
      '`--import ./src/__tests__/helpers/isolateHome.mjs`), never bare `node --test`.',
  );
}

const PACK = 'qodana-mit';
const FIXTURE = fileURLToPath(new URL('./fixtures/opengrep-scan.json', import.meta.url));
const ENGINE = { command: 'C:\\fake\\opengrep.exe', source: 'path' as const, version: '1.30.0' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// A fake `git fetch` of the pack: one rule file (so pruning keeps it), plus a
// marker naming this install so a test can tell which tree is in place. Waits
// on `gate` when given.
function fakeFetch(marker: string, gate?: Promise<void>) {
  return async (_repo: string, _commit: string, dest: string): Promise<void> => {
    await fs.mkdir(dest, { recursive: true });
    await fs.writeFile(path.join(dest, `${marker}.yaml`), 'rules:\n  - id: fake-rule\n');
    if (gate) await gate;
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// A fake engine that signals when it starts and only exits once `release`
// resolves, writing the fixture to its `-o` path.
function blockingSpawn(started: () => void, release: Promise<void>) {
  return async (_command: string, args: string[]): Promise<SpawnWithTimeoutResult> => {
    started();
    await release;
    await fs.copyFile(FIXTURE, args[args.indexOf('-o') + 1]);
    return { code: 0, stdout: '', stderr: '', combined: '', timedOut: false, error: null };
  };
}

async function withProject<T>(fn: (project: string) => Promise<T>): Promise<T> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-opengrep-overlap-'));
  try {
    return await fn(project);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
  }
}

test('removing a pack while its install is still fetching is not undone when the fetch completes', async () => {
  await installRulePack(PACK, { fetchCommit: fakeFetch('v1') });
  assert.ok((await readOpengrepState()).packs[PACK], 'installed to start with');

  const fetchGate = deferred();
  const reinstall = installRulePack(PACK, { fetchCommit: fakeFetch('v2', fetchGate.promise) });
  assert.equal(isRulePackInstalling(PACK), true);
  await tick();

  await removeRulePack(PACK);
  fetchGate.resolve();
  await assert.rejects(reinstall, /removed while it was installing/);

  assert.equal((await readOpengrepState()).packs[PACK], undefined, 'the state entry stays removed');
  assert.equal(await exists(rulePackDir(PACK)), false, 'the pack directory stays removed');
  const leftovers = (await fs.readdir(rulesRootDir())).filter((n) => n.startsWith(`.tmp-${PACK}-`));
  assert.deepEqual(leftovers, [], 'the discarded fetch tree is cleaned up');
  assert.equal(isRulePackInstalling(PACK), false);
});

test('DELETE /api/opengrep/rules/:packId answers 409 while that pack is installing', async () => {
  const app = express();
  app.use(express.json());
  app.use(buildOpengrepRouter());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const fetchGate = deferred();
  const install = installRulePack(PACK, { fetchCommit: fakeFetch('v3', fetchGate.promise) });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/opengrep/rules/${PACK}`, { method: 'DELETE' });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, 'installing');
  } finally {
    fetchGate.resolve();
    await install;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.ok((await readOpengrepState()).packs[PACK], 'the refused removal left the install alone');
  assert.ok(await exists(path.join(rulePackDir(PACK), 'v3.yaml')));
});

test("a scan started mid-install holds the swap until its engine exits; a scan arriving during the swap's wait waits for it", async () => {
  await installRulePack(PACK, { fetchCommit: fakeFetch('old') });
  const before = (await readOpengrepState()).packs[PACK]!.installedAt;

  await withProject(async (projectA) =>
    withProject(async (projectB) => {
      // 1. The install is fetching…
      const fetchGate = deferred();
      const install = installRulePack(PACK, { fetchCommit: fakeFetch('new', fetchGate.promise) });
      await tick();

      // 2. …when a scan starts and its engine begins reading the pack.
      const engineA = deferred();
      const releaseA = deferred();
      const scanA = runOpengrepScan(
        { project: projectA, packIds: [PACK] },
        { resolve: async () => ENGINE, spawn: blockingSpawn(engineA.resolve, releaseA.promise) },
      );
      await engineA.promise;

      // 3. The fetch finishes. The swap must wait for the running scan.
      fetchGate.resolve();
      await tick(80);
      assert.equal(getRulePackJob(PACK)?.status, 'running', 'the install is parked before its swap');
      assert.equal(isRulesMutationPending(), true);
      assert.ok(await exists(path.join(rulePackDir(PACK), 'old.yaml')), 'the tree the engine reads is untouched');
      assert.equal((await readOpengrepState()).packs[PACK]!.installedAt, before);

      // 4. A second scan arriving now waits for the pending swap instead of
      //    starting on a tree about to be renamed.
      let engineBStarted = false;
      const scanB = runOpengrepScan(
        { project: projectB, packIds: [PACK] },
        {
          resolve: async () => ENGINE,
          spawn: blockingSpawn(() => {
            engineBStarted = true;
          }, Promise.resolve()),
        },
      );
      await tick(80);
      assert.equal(engineBStarted, false, 'the new scan waits for the swap');

      // 5. The first scan's engine exits: the swap lands, then the waiting
      //    scan runs against the NEW tree.
      releaseA.resolve();
      await scanA;
      await install;
      assert.equal(getRulePackJob(PACK)?.status, 'done');
      assert.ok(await exists(path.join(rulePackDir(PACK), 'new.yaml')));
      assert.ok((await readOpengrepState()).packs[PACK]!.installedAt >= before);
      const recordB = await scanB;
      assert.equal(engineBStarted, true);
      assert.deepEqual(recordB.packIds, [PACK], 'the waiting scan still used the pack');
    }),
  );
});

test('removing a pack while a scan is running is refused (busy) rather than deleting a tree the engine reads', async () => {
  await installRulePack(PACK, { fetchCommit: fakeFetch('in-use') });
  await withProject(async (project) => {
    const engine = deferred();
    const release = deferred();
    const scan = runOpengrepScan(
      { project, packIds: [PACK] },
      { resolve: async () => ENGINE, spawn: blockingSpawn(engine.resolve, release.promise) },
    );
    await engine.promise;
    await assert.rejects(removeRulePack(PACK), OpengrepRulesBusyError);
    assert.ok(await exists(rulePackDir(PACK)), 'nothing was deleted');
    release.resolve();
    await scan;
    await removeRulePack(PACK);
    assert.equal(await exists(rulePackDir(PACK)), false);
  });
});
