import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StartupTerminal, TerminalRecord } from '../api';
import type { TerminalSpec } from '../terminal/terminalTypes';
import {
  planRestart,
  planStartupSeeding,
  settleInFlightStartups,
  startupInFlightKey,
} from '../components/sidebar/hooks/startupSeedPlan.ts';

// The seeding pass of useStartupTerminals. Regression: on a fresh browser
// context the sidebar's local list is empty until the registry snapshot lands,
// and deciding from the local list alone spawned a SECOND `npm run dev` for a
// startup whose pty was alive and about to be re-attached by the registry.

const P = 'C:\\proj';
const dev: StartupTerminal = { id: 's1', label: 'dev', command: 'npm run dev' };
const blank: StartupTerminal = { id: 's2', label: '', command: '   ' };

function rec(over: Partial<TerminalRecord> & { id: string }): TerminalRecord {
  return {
    projectPath: P, cwd: P, label: over.id, order: 0, owner: 'startup', startupId: 's1',
    launch: { initialCommand: 'npm run dev' }, serverId: `srv_${over.id}`,
    createdAt: 1, updatedAt: 1, ...over,
  };
}

function spec(over: Partial<TerminalSpec> & { id: string }): TerminalSpec {
  return { label: over.id, cwd: P, projectPath: P, kind: 'startup', startupId: 's1', ...over };
}

test('a startup alive in the registry but not yet in the local list is NOT respawned', () => {
  const plan = planStartupSeeding({
    activeFolder: P, configs: [dev, blank], existing: [],
    liveIds: new Set(['srv_a']), records: [rec({ id: 'a' })], inFlight: new Set(),
  });
  assert.deepEqual(plan.spawn, []);
  assert.deepEqual(plan.staleIds, []);
});

test('a startup whose registry pty is dead (or which has no record) is respawned once', () => {
  const dead = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [],
    liveIds: new Set(['srv_other']), records: [rec({ id: 'a' })], inFlight: new Set(),
  });
  assert.deepEqual(dead.spawn, [dev]);
  const none = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [], liveIds: new Set(), records: [], inFlight: new Set(),
  });
  assert.deepEqual(none.spawn, [dev]);
  // An ended record, or one with no pty (never relaunched for startups), does not count as live.
  const ended = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [], liveIds: new Set(['srv_a']),
    records: [rec({ id: 'a', ended: { at: 1, reason: 'exit' } }), rec({ id: 'b', serverId: undefined })],
    inFlight: new Set(),
  });
  assert.deepEqual(ended.spawn, [dev]);
  // Already being spawned by this hook → not again.
  const inflight = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [], liveIds: new Set(), records: [],
    inFlight: new Set([startupInFlightKey(P, 's1')]),
  });
  assert.deepEqual(inflight.spawn, []);
});

test('local specs: a live one blocks the spawn, a dead unregistered one is stale, a registered one is left to the registry', () => {
  const live = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [spec({ id: 'l', serverId: 'srv_l' })],
    liveIds: new Set(['srv_l']), records: [], inFlight: new Set(),
  });
  assert.deepEqual(live.spawn, []);
  const deadLegacy = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [spec({ id: 'l', serverId: 'srv_dead' })],
    liveIds: new Set(), records: [], inFlight: new Set(),
  });
  assert.deepEqual(deadLegacy.staleIds, ['l']);
  assert.deepEqual(deadLegacy.spawn, [dev]);
  const deadRegistered = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [spec({ id: 'r', serverId: 'srv_dead', registered: true })],
    liveIds: new Set(), records: [], inFlight: new Set(),
  });
  assert.deepEqual(deadRegistered.staleIds, [], 'never DELETE a registered record here');
  assert.deepEqual(deadRegistered.spawn, [dev]);
});

test('backend unreachable (both reads failed) spawns nothing, even with no local specs', () => {
  // A fresh browser context during a backend restart: no local specs, and
  // neither `GET /api/terminals` nor the registry answered. Live ptys survive
  // the restart, so spawning here put a second `npm run dev` beside the
  // still-alive one once the backend came back.
  const plan = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [], liveIds: null, records: null, inFlight: new Set(),
  });
  assert.deepEqual(plan, { staleIds: [], spawn: [] });
  // One of the two answering is enough to plan from.
  const registryOnly = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [], liveIds: null, records: [], inFlight: new Set(),
  });
  assert.deepEqual(registryOnly.spawn, [dev]);
  const liveOnly = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [], liveIds: new Set(), records: null, inFlight: new Set(),
  });
  assert.deepEqual(liveOnly.spawn, [dev]);
});

test('an unreadable live set never drops anything and treats every pty as alive', () => {
  const plan = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [spec({ id: 'l', serverId: 'srv_maybe' })],
    liveIds: null, records: null, inFlight: new Set(),
  });
  assert.deepEqual(plan, { staleIds: [], spawn: [] });
});

test('a local startup spec in the backend realpath spelling still counts as live', () => {
  // `existing` is already project-scoped (normalized); a strict projectPath
  // compare treated a registry-restored tab as absent and spawned a duplicate.
  const plan = planStartupSeeding({
    activeFolder: P, configs: [dev],
    existing: [spec({ id: 'l', projectPath: 'c:/proj', serverId: 'srv_l' })],
    liveIds: new Set(['srv_l']), records: null, inFlight: new Set(),
  });
  assert.deepEqual(plan.spawn, []);
});

test('in-flight markers survive unrelated list changes and settle only on commit', () => {
  const inFlight = new Set([startupInFlightKey(P, 's1')]);
  // Another tab's status update while the pre-create is still pending.
  settleInFlightStartups(inFlight, P, [spec({ id: 'x', kind: undefined, startupId: undefined })]);
  assert.ok(inFlight.has(startupInFlightKey(P, 's1')), 'pending marker must survive');
  // The spawn's spec commits (in the realpath spelling) → the marker drops.
  settleInFlightStartups(inFlight, P, [spec({ id: 'a', projectPath: 'c:/proj' })]);
  assert.equal(inFlight.size, 0);
});

test('a second restart click while the first click spawns are pending spawns nothing', () => {
  // Regression: the restart spawns await their pre-create before the tab
  // exists, so a double-click found nothing to close and spawned every
  // startup command twice (two `npm run dev`s fighting for one port).
  const other: StartupTerminal = { id: 's3', label: 'watch', command: 'npm run watch' };
  const inFlight = new Set<string>();
  const first = planRestart([dev, blank, other], inFlight, P);
  assert.deepEqual(first, [dev, other], 'blank commands are never spawned');
  for (const cfg of first) inFlight.add(startupInFlightKey(P, cfg.id));
  assert.deepEqual(planRestart([dev, blank, other], inFlight, P), []);
  // The marker is keyed on the normalized folder, so another spelling of the
  // same project is still blocked.
  assert.deepEqual(planRestart([dev], inFlight, 'c:/proj'), []);
  // Once the first click's specs commit, a later restart respawns them again.
  settleInFlightStartups(inFlight, P, [spec({ id: 'a' }), spec({ id: 'b', startupId: 's3' })]);
  assert.deepEqual(planRestart([dev, blank, other], inFlight, P), [dev, other]);
});
