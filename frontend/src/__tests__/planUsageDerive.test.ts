// The navbar plan-usage chip: each provider shows its most-used window (the
// one that binds first), tone thresholds at 70 / 90 %, a provider that couldn't
// be read shows a muted "—" rather than disappearing, and reset / staleness
// copy reads naturally at minute, hour and day scales.

import assert from 'node:assert/strict';
import test from 'node:test';

import type { PlanUsageProvider, PlanUsageReport } from '../api';
import { bindingWindow, chipParts, chipTitle, guardChoices, guardHeldText, resetText, staleText, usageTone } from '../components/planUsageDerive';

const NOW = Date.parse('2026-10-22T20:00:00Z');
const claude: PlanUsageProvider = {
  provider: 'claude', status: 'ok', plan: 'Max 20x', source: 'Claude usage API', asOf: '2026-10-22T20:00:00Z', notes: [],
  windows: [
    { id: 'session', label: '5-hour session', usedPercent: 13, windowMinutes: 300, resetsAt: '2026-10-22T20:42:00Z' },
    { id: 'week', label: 'Week, all models', usedPercent: 74.6, windowMinutes: 10080, resetsAt: '2026-10-29T18:00:00Z' },
  ],
};
const codexDown: PlanUsageProvider = { provider: 'codex', status: 'unavailable', windows: [], notes: [], source: 'Codex app-server', asOf: '2026-10-22T20:00:00Z', message: 'not signed in' };

test('usageTone thresholds', () => {
  assert.equal(usageTone(0), 'ok');
  assert.equal(usageTone(69.9), 'ok');
  assert.equal(usageTone(70), 'warn');
  assert.equal(usageTone(90), 'high');
});

test('bindingWindow picks the most-used window, ties to the later reset', () => {
  assert.equal(bindingWindow(claude)?.id, 'week');
  const tie: PlanUsageProvider = { ...claude, windows: [{ id: 'a', label: 'A', usedPercent: 50, resetsAt: '2026-10-23T00:00:00Z' }, { id: 'b', label: 'B', usedPercent: 50, resetsAt: '2026-10-29T00:00:00Z' }] };
  assert.equal(bindingWindow(tie)?.id, 'b');
  assert.equal(bindingWindow({ ...claude, windows: [] }), null);
});

test('chipParts: one part per provider, unreadable ones muted', () => {
  const report: PlanUsageReport = { providers: [claude, codexDown] };
  assert.deepEqual(chipParts(report), [
    { provider: 'claude', label: 'Claude', text: '75%', tone: 'warn' },
    { provider: 'codex', label: 'Codex', text: '—', tone: 'muted' },
  ]);
  assert.deepEqual(chipParts(null), []);
  assert.equal(chipTitle(report), 'Claude: 75% of the week, all models limit used\nCodex: not signed in');
});

test('resetText and staleText scale their units', () => {
  assert.equal(resetText('2026-10-22T20:42:00Z', NOW), 'resets in 42 min');
  assert.equal(resetText('2026-10-23T00:20:00Z', NOW), 'resets in 4 h 20 min');
  assert.equal(resetText('2026-10-23T01:00:00Z', NOW), 'resets in 5 h');
  assert.match(resetText('2026-10-29T18:00:00Z', NOW), /^resets [A-Z][a-z]{2} \d\d:\d\d$/);
  assert.equal(resetText('2026-10-22T19:00:00Z', NOW), 'resets now');
  assert.equal(resetText(undefined, NOW), '');
  assert.equal(staleText('2026-10-22T19:59:30Z', NOW), '');
  assert.equal(staleText('2026-10-22T19:30:00Z', NOW), 'as of 30 min ago');
  assert.equal(staleText('2026-10-19T04:29:54Z', NOW), 'as of 4 days ago');
});

test('plan guard: the select offers presets plus any custom stored value; held text only while holding', () => {
  assert.deepEqual(guardChoices(null), [0, 80, 90, 95, 99]);
  assert.deepEqual(guardChoices(90), [0, 80, 90, 95, 99]);
  assert.deepEqual(guardChoices(85), [0, 80, 85, 90, 95, 99]);
  assert.equal(guardHeldText(undefined), '');
  assert.equal(guardHeldText({ percent: 90, held: 0 }), '');
  assert.equal(guardHeldText({ percent: null, held: 3 }), '');
  assert.equal(guardHeldText({ percent: 90, held: 1 }), 'Holding 1 agent start until the plan resets');
  assert.equal(guardHeldText({ percent: 90, held: 2 }), 'Holding 2 agent starts until the plan resets');
});
