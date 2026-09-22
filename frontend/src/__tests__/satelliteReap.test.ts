import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReapSatellite } from '../components/forceGraph/agentOverlaySatellites.ts';
import { SATELLITE_IDLE_TTL_MS } from '../components/forceGraph/agentOverlayConstants.ts';

// Regression: the missed-SubagentStop safety net required `beams.size === 0`,
// but a subagent's current-file beam is persistent (`endAt = Infinity`) from
// its first tool use on — so a subagent whose stop was lost kept its satellite
// (and lit beam) for the parent's whole session. Only a FADING beam means
// "still active".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sat = (lastSeen: number, ...endAts: number[]): any => ({
  lastSeen,
  beams: new Map(endAts.map((endAt, i) => [`f${i}`, { endAt }])),
});

test('a quiet satellite still showing only its persistent last-file beam is reaped', () => {
  const now = 10 * SATELLITE_IDLE_TTL_MS;
  assert.equal(shouldReapSatellite(sat(0, Infinity), now), true);
  assert.equal(shouldReapSatellite(sat(0), now), true, 'no beams at all');
});

test('a recently-seen satellite, or one with a fading beam, is kept', () => {
  const now = 10 * SATELLITE_IDLE_TTL_MS;
  assert.equal(shouldReapSatellite(sat(now - 1000, Infinity), now), false, 'recent');
  assert.equal(shouldReapSatellite(sat(0, Infinity, now + 500), now), false, 'fading beam');
});
