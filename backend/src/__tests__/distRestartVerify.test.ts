import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  describeDistEvent,
  newestDistMtimeMs,
  shouldRestartForDist,
} from '../../scripts/dev/distSignature.mjs';
import { createRestartPolicy } from '../../scripts/dev/restartPolicy.mjs';

// Regression for: the backend restarted itself mid-workflow with NO dist/ file
// written that day (every dist mtime still on the previous build), killing an
// in-flight run for no reason — several times over a week, always unexplained.
//
// Cause: `fs.watch('dist', {recursive:true})` is not a "bytes changed" signal on
// Windows. libuv arms ReadDirectoryChangesW with a filter that also includes
// ATTRIBUTES / LAST_ACCESS / CREATION / SECURITY, so an NTFS last-access flush
// (last-access updates are ENABLED on the affected machine), an AV/indexer
// scan, or an ACL refresh fires it too. The dev runner restarted on every
// event, and logged only "dist/ changed" — no file, no event type — so the
// restarts were unattributable after the fact.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The pure guards
// ---------------------------------------------------------------------------

test('shouldRestartForDist: restart only when the tree is genuinely newer', () => {
  assert.equal(shouldRestartForDist({ newest: 200, baseline: 100 }), true);
  assert.equal(
    shouldRestartForDist({ newest: 100, baseline: 100 }),
    false,
    'an event with no newer write is metadata-only — the incident case',
  );
  assert.equal(shouldRestartForDist({ newest: 50, baseline: 100 }), false);
});

test('shouldRestartForDist: an unknown mtime fails OPEN', () => {
  // Missing a real code change is far worse than one spurious restart, so
  // "couldn't read dist/" and "no baseline yet" both restart.
  assert.equal(shouldRestartForDist({ newest: null, baseline: 100 }), true);
  assert.equal(shouldRestartForDist({ newest: 200, baseline: null }), true);
  assert.equal(shouldRestartForDist({ newest: undefined, baseline: undefined }), true);
});

test('newestDistMtimeMs sees a nested write, a new file, and a delete', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lattice-distsig-'));
  try {
    await fs.mkdir(path.join(dir, 'nested', 'deep'), { recursive: true });
    await fs.writeFile(path.join(dir, 'nested', 'deep', 'a.js'), 'a', 'utf8');
    const baseline = newestDistMtimeMs(dir);
    assert.ok(typeof baseline === 'number' && baseline > 0);

    await sleep(20);
    await fs.writeFile(path.join(dir, 'nested', 'deep', 'a.js'), 'a2', 'utf8');
    const afterWrite = newestDistMtimeMs(dir);
    assert.ok(afterWrite! > baseline!, 'a nested rewrite must advance the signature');

    await sleep(20);
    await fs.writeFile(path.join(dir, 'nested', 'b.js'), 'b', 'utf8');
    const afterCreate = newestDistMtimeMs(dir);
    assert.ok(afterCreate! > afterWrite!, 'a new file must advance the signature');

    await sleep(20);
    await fs.rm(path.join(dir, 'nested', 'b.js'));
    const afterDelete = newestDistMtimeMs(dir);
    // No surviving FILE moved, so this only works because directory mtimes
    // are folded in — tsc removing a stale output still counts as a rebuild.
    assert.ok(afterDelete! > afterCreate!, 'a delete must advance the signature');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('newestDistMtimeMs returns null (not 0) when the tree cannot be read', () => {
  // 0 would read as "older than the baseline" → the guard would suppress every
  // restart. `null` routes to the fail-open branch instead.
  assert.equal(newestDistMtimeMs(path.join(os.tmpdir(), 'lattice-no-such-dist-dir')), null);
});

test('describeDistEvent always yields something loggable', () => {
  assert.equal(describeDistEvent('change', 'workflowRuns/state.js'), 'change workflowRuns/state.js');
  // fs.watch can deliver a null filename — itself a hint that the event is the
  // metadata-only shape, so it must be visible in the log rather than blank.
  assert.equal(describeDistEvent('rename', null), 'rename (no filename)');
  assert.equal(describeDistEvent(undefined, undefined), 'unknown (no filename)');
});

// ---------------------------------------------------------------------------
// The policy wiring
// ---------------------------------------------------------------------------

function harness(mtimes: (number | null)[]) {
  const reasons: string[] = [];
  let i = 0;
  const policy = createRestartPolicy({
    restartBackend: (reason: string) => {
      reasons.push(reason);
      return true;
    },
    operationInFlight: () => false,
    workflowInFlight: () => false,
    readNewestDistMtime: () => mtimes[Math.min(i++, mtimes.length - 1)],
    now: () => 1_000_000,
  });
  return { policy, reasons };
}

test('a metadata-only dist/ event does NOT restart the backend', () => {
  // seed baseline = 500, then every event reports the same 500 → no write.
  const { policy, reasons } = harness([500, 500, 500, 500]);
  policy.resetDistBaseline();
  policy.onDistChanged();
  policy.onDistChanged();
  assert.deepEqual(reasons, [], 'the incident: restarts with nothing written');
});

test('a real dist/ write restarts, and names the event that fired', () => {
  const { policy, reasons } = harness([500, 900, 900]);
  policy.resetDistBaseline();
  policy.scheduleDistChanged('change', 'workflowRuns/state.js');
  policy.onDistChanged();
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /dist\/ changed \(change workflowRuns\/state\.js\)/);

  // The applied restart re-baselines, so the trailing events of the same
  // compile burst don't restart a second time.
  policy.onDistChanged();
  assert.equal(reasons.length, 1);
});

test('an unreadable dist/ still restarts (fail open — never miss a rebuild)', () => {
  const { policy, reasons } = harness([500, null, null]);
  policy.resetDistBaseline();
  policy.onDistChanged();
  assert.equal(reasons.length, 1, 'can-not-tell must not suppress a restart');
});

test('a metadata-only event cannot arm a deferral for the poll to apply later', () => {
  // Otherwise the guard would be bypassed: a spurious event during a merge run
  // would defer, and the poll would restart the moment the lock cleared.
  const reasons: string[] = [];
  const policy = createRestartPolicy({
    restartBackend: (reason: string) => {
      reasons.push(reason);
      return true;
    },
    operationInFlight: () => true, // a run holds the lock
    workflowInFlight: () => false,
    readNewestDistMtime: () => 500, // never advances
    now: () => 1_000_000,
  });
  policy.resetDistBaseline();
  policy.onDistChanged();

  // Lock clears; the poll must find nothing deferred.
  const cleared = createRestartPolicy({
    restartBackend: (reason: string) => {
      reasons.push(reason);
      return true;
    },
    operationInFlight: () => false,
    workflowInFlight: () => false,
    readNewestDistMtime: () => 500,
    now: () => 1_000_000,
  });
  cleared.resetDistBaseline();
  assert.deepEqual(reasons, []);
});
