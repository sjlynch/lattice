import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StartupTerminal, TerminalRecord } from '../api';
import type { TerminalSpec } from '../terminal/terminalTypes';
import {
  planStartupSeeding,
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

test('an unreadable live set never drops anything and treats every pty as alive', () => {
  const plan = planStartupSeeding({
    activeFolder: P, configs: [dev], existing: [spec({ id: 'l', serverId: 'srv_maybe' })],
    liveIds: null, records: null, inFlight: new Set(),
  });
  assert.deepEqual(plan, { staleIds: [], spawn: [] });
});
