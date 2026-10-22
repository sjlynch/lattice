// Plan usage (GET /api/plan-usage): Claude's OAuth usage body and Codex's
// rate-limit shapes (app-server camelCase and rollout snake_case) parse into
// the same windows; an expired or missing Claude sign-in is reported, never
// refreshed (a refresh would rotate Claude Code's token and sign it out); Codex
// falls back to the newest rollout snapshot with that snapshot's timestamp;
// and the per-provider cache keeps polling tabs and agents off the providers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPlanUsageService } from '../planUsage.js';
import { claudePlanName, parseClaudeUsage, readClaudeUsage, CLAUDE_USAGE_URL } from '../planUsage/claude.js';
import { codexWindowLabel, parseCodexRateLimits, readCodexUsage, readLatestRolloutSnapshot } from '../planUsage/codex.js';
import type { PlanUsageProvider } from '../planUsage/types.js';

const NOW = Date.parse('2026-10-22T20:00:00Z');
const CLAUDE_BODY = {
  five_hour: { utilization: 11, resets_at: '2026-10-23T00:20:00.409963+00:00' },
  seven_day: { utilization: 3, resets_at: '2026-10-29T18:00:00.409986+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 1.5, resets_at: null },
  tangelo: { utilization: 99 },
  extra_usage: { is_enabled: false },
};
const creds = (o: object) => async () => JSON.stringify({ claudeAiOauth: o });

test('parseClaudeUsage maps known windows, skips null and unknown keys, notes extra usage', () => {
  const { windows, notes } = parseClaudeUsage(CLAUDE_BODY);
  assert.deepEqual(windows, [
    { id: 'session', label: '5-hour session', usedPercent: 11, windowMinutes: 300, resetsAt: '2026-10-23T00:20:00.409Z' },
    { id: 'week', label: 'Week, all models', usedPercent: 3, windowMinutes: 10080, resetsAt: '2026-10-29T18:00:00.409Z' },
    { id: 'week-sonnet', label: 'Week, Sonnet', usedPercent: 1.5, windowMinutes: 10080 },
  ]);
  assert.deepEqual(notes, ['Extra usage is off: a limit stops usage until it resets']);
  assert.deepEqual(parseClaudeUsage(null), { windows: [], notes: [] });
});

test('claudePlanName reads the tier multiplier', () => {
  assert.equal(claudePlanName('max', 'default_claude_max_20x'), 'Max 20x');
  assert.equal(claudePlanName('pro', 'default_claude_pro'), 'Pro');
  assert.equal(claudePlanName(undefined, 'x'), undefined);
});

test('readClaudeUsage sends the stored token to the usage API only, and parses the answer', async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify(CLAUDE_BODY), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await readClaudeUsage({ readCredentials: creds({ accessToken: 'tok', expiresAt: NOW + 3600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }), fetchImpl, now: () => NOW });
  assert.deepEqual(calls, [{ url: CLAUDE_USAGE_URL, auth: 'Bearer tok' }]);
  assert.equal(r.status, 'ok');
  assert.equal(r.plan, 'Max 20x');
  assert.equal(r.windows.length, 3);
  assert.ok(!JSON.stringify(r).includes('tok'), 'the token never appears in the report');
});

test('readClaudeUsage reports a missing, signed-out or expired sign-in without calling the API', async () => {
  const fetchImpl = (async () => { throw new Error('must not be called'); }) as unknown as typeof fetch;
  const missing = await readClaudeUsage({ readCredentials: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, fetchImpl, now: () => NOW });
  assert.equal(missing.status, 'unavailable');
  const noToken = await readClaudeUsage({ readCredentials: creds({ subscriptionType: 'pro' }), fetchImpl, now: () => NOW });
  assert.equal(noToken.status, 'unavailable');
  assert.equal(noToken.plan, 'Pro');
  const expired = await readClaudeUsage({ readCredentials: creds({ accessToken: 'tok', expiresAt: NOW - 1 }), fetchImpl, now: () => NOW });
  assert.equal(expired.status, 'expired');
  assert.match(expired.message ?? '', /refreshes the next time Claude Code runs/);
});

test('readClaudeUsage maps 401 to expired and other failures to error', async () => {
  const answer = (status: number, body = '{}') => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const base = { readCredentials: creds({ accessToken: 'tok', expiresAt: NOW + 1000 }), now: () => NOW };
  assert.equal((await readClaudeUsage({ ...base, fetchImpl: answer(401) })).status, 'expired');
  assert.equal((await readClaudeUsage({ ...base, fetchImpl: answer(500) })).status, 'error');
  assert.equal((await readClaudeUsage({ ...base, fetchImpl: answer(200, '{}') })).status, 'error');
  const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
  assert.equal((await readClaudeUsage({ ...base, fetchImpl: down })).status, 'error');
});

test('parseCodexRateLimits reads app-server camelCase and rollout snake_case alike', () => {
  const live = parseCodexRateLimits(
    { primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1793312661 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '21956.74' }, planType: 'pro' },
    { resetCredits: { availableCount: 2 } },
  );
  assert.deepEqual(live.windows, [{ id: 'primary', label: 'Week', usedPercent: 0, windowMinutes: 10080, resetsAt: new Date(1793312661 * 1000).toISOString() }]);
  assert.equal(live.plan, 'Pro');
  assert.deepEqual(live.notes, ['Credits balance 21,956: past a limit, usage draws on credits', '2 free rate-limit resets available (in Codex)']);
  const snap = parseCodexRateLimits({ primary: { used_percent: 100, window_minutes: 300, resets_at: 1792878850 }, secondary: { used_percent: 40, window_minutes: 10080 }, plan_type: 'plus', rate_limit_reached_type: 'primary' });
  assert.deepEqual(snap.windows.map((w) => [w.id, w.label, w.usedPercent]), [['primary', '5-hour', 100], ['secondary', 'Week', 40]]);
  assert.deepEqual(snap.notes, ['Limit reached: primary']);
  assert.equal(codexWindowLabel(1440), 'Day');
  assert.equal(codexWindowLabel(45), '45-minute');
});

test('readCodexUsage prefers the app-server, else the newest snapshot with its own time, else unavailable', async () => {
  const live = await readCodexUsage({
    appServerRateLimits: async () => ({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1793312661 }, planType: 'pro' } }),
    latestSnapshot: async () => { throw new Error('not reached'); },
    now: () => NOW,
  });
  assert.equal(live.status, 'ok');
  assert.equal(live.source, 'Codex app-server');
  assert.equal(live.asOf, new Date(NOW).toISOString());
  const fallback = await readCodexUsage({
    appServerRateLimits: async () => { throw new Error('ENOENT'); },
    latestSnapshot: async () => ({ at: '2026-10-19T04:29:54.781Z', rateLimits: { primary: { used_percent: 100, window_minutes: 10080 } } }),
    now: () => NOW,
  });
  assert.equal(fallback.status, 'ok');
  assert.equal(fallback.asOf, '2026-10-19T04:29:54.781Z');
  assert.match(fallback.source, /session log/);
  const none = await readCodexUsage({ appServerRateLimits: async () => null, latestSnapshot: async () => null, now: () => NOW });
  assert.equal(none.status, 'unavailable');
});

test('readLatestRolloutSnapshot finds the newest rate_limits line across day folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sessions-'));
  try {
    const line = (ts: string, used: number) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 10080 } } } });
    fs.mkdirSync(path.join(root, '2026', '10', '18'), { recursive: true });
    fs.mkdirSync(path.join(root, '2026', '10', '19'), { recursive: true });
    fs.writeFileSync(path.join(root, '2026', '10', '18', 'rollout-a.jsonl'), `${line('2026-10-18T01:00:00Z', 50)}\n`);
    fs.writeFileSync(path.join(root, '2026', '10', '19', 'rollout-b.jsonl'), `${line('2026-10-19T01:00:00Z', 70)}\n${line('2026-10-19T02:00:00Z', 80)}\n{"timestamp":"2026-10-19T03:00:00Z","payload":{"type":"other"}}\n`);
    const snap = await readLatestRolloutSnapshot(root);
    assert.equal(snap?.at, '2026-10-19T02:00:00Z');
    assert.equal((snap?.rateLimits as { primary: { used_percent: number } }).primary.used_percent, 80);
    assert.equal(await readLatestRolloutSnapshot(path.join(root, 'missing')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the service caches per provider, refreshes at most every 15 s, and shares one in-flight read', async () => {
  let t = 0;
  const counts = { claude: 0, codex: 0 };
  const reader = (id: 'claude' | 'codex') => async (): Promise<PlanUsageProvider> => {
    counts[id]++;
    await new Promise((r) => setTimeout(r, 5));
    return { provider: id, status: 'ok', windows: [], notes: [], source: 'test', asOf: String(t) };
  };
  const svc = createPlanUsageService({ claude: reader('claude'), codex: reader('codex') }, () => t);
  await Promise.all([svc.read(), svc.read()]);
  assert.deepEqual(counts, { claude: 1, codex: 1 }, 'concurrent reads share one fetch');
  t = 10_000;
  await svc.read({ refresh: true });
  assert.deepEqual(counts, { claude: 1, codex: 1 }, 'a refresh within 15 s reuses the result');
  t = 30_000;
  await svc.read();
  assert.deepEqual(counts, { claude: 1, codex: 1 }, 'a plain read reuses a result under 60 s old');
  await svc.read({ refresh: true });
  assert.deepEqual(counts, { claude: 2, codex: 2 }, 'a refresh after 15 s fetches again');
  t = 100_000;
  await svc.read();
  assert.deepEqual(counts, { claude: 3, codex: 3 });
});
