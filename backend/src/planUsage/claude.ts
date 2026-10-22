// Claude subscription usage (the numbers Claude Code's /usage shows): the
// 5-hour session window and the weekly windows, from Anthropic's OAuth usage
// endpoint, authorized with the access token Claude Code stores in
// `<CLAUDE_CONFIG_DIR>/.credentials.json`.
//
// Read-only on purpose. Lattice never refreshes the token: a refresh rotates
// the refresh token and would sign Claude Code out. An expired token reports
// `expired` until Claude Code next runs and refreshes it. The token goes only
// to api.anthropic.com in an Authorization header and is never logged or
// returned. On macOS the sign-in lives in the Keychain, which Lattice doesn't
// read, so the provider reports `unavailable` there.

import fs from 'node:fs/promises';
import path from 'node:path';

import { claudeConfigDir } from '../terminalRegistry/harnessPaths.js';
import type { PlanUsageProvider, PlanUsageWindow } from './types.js';

export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export type ClaudeUsageDeps = {
  readCredentials: () => Promise<string>;
  fetchImpl: typeof fetch;
  now: () => number;
};

const defaultDeps = (): ClaudeUsageDeps => ({
  readCredentials: () => fs.readFile(path.join(claudeConfigDir(), '.credentials.json'), 'utf8'),
  fetchImpl: fetch,
  now: Date.now,
});

type OAuth = { accessToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown; rateLimitTier?: unknown };

// "max" + "default_claude_max_20x" → "Max 20x"; "pro" → "Pro".
export function claudePlanName(subscriptionType: unknown, tier: unknown): string | undefined {
  if (typeof subscriptionType !== 'string' || !subscriptionType) return undefined;
  const name = subscriptionType[0].toUpperCase() + subscriptionType.slice(1);
  const mult = typeof tier === 'string' ? /_(\d+x)$/.exec(tier)?.[1] : undefined;
  return mult ? `${name} ${mult}` : name;
}

const WINDOWS: Array<[key: string, id: string, label: string, minutes: number]> = [
  ['five_hour', 'session', '5-hour session', 300],
  ['seven_day', 'week', 'Week, all models', 10080],
  ['seven_day_opus', 'week-opus', 'Week, Opus', 10080],
  ['seven_day_sonnet', 'week-sonnet', 'Week, Sonnet', 10080],
];

// The usage endpoint's body → windows + notes. Unknown or null windows are
// skipped; the endpoint carries many experimental keys this ignores.
export function parseClaudeUsage(body: unknown): { windows: PlanUsageWindow[]; notes: string[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const windows: PlanUsageWindow[] = [];
  for (const [key, id, label, minutes] of WINDOWS) {
    const w = b[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) continue;
    const resetsAt = typeof w.resets_at === 'string' && !Number.isNaN(Date.parse(w.resets_at))
      ? new Date(w.resets_at).toISOString()
      : undefined;
    windows.push({ id, label, usedPercent: w.utilization, windowMinutes: minutes, ...(resetsAt ? { resetsAt } : {}) });
  }
  const notes: string[] = [];
  const extra = b.extra_usage as { is_enabled?: unknown } | null | undefined;
  if (extra && typeof extra.is_enabled === 'boolean') {
    notes.push(extra.is_enabled ? 'Extra usage is on: past a limit, usage is billed' : 'Extra usage is off: a limit stops usage until it resets');
  }
  return { windows, notes };
}

export async function readClaudeUsage(deps: ClaudeUsageDeps = defaultDeps()): Promise<PlanUsageProvider> {
  const asOf = new Date(deps.now()).toISOString();
  const base = { provider: 'claude' as const, windows: [], notes: [], source: 'Claude usage API', asOf };
  let oauth: OAuth;
  try {
    oauth = ((JSON.parse(await deps.readCredentials()) as { claudeAiOauth?: OAuth }).claudeAiOauth ?? {}) as OAuth;
  } catch {
    return { ...base, status: 'unavailable', message: 'No Claude Code sign-in found (.credentials.json). Sign in with `claude` first; on macOS the sign-in is in the Keychain, which Lattice does not read.' };
  }
  const plan = claudePlanName(oauth.subscriptionType, oauth.rateLimitTier);
  if (typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return { ...base, status: 'unavailable', ...(plan ? { plan } : {}), message: 'Claude Code is not signed in with a Claude subscription.' };
  }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= deps.now()) {
    return { ...base, status: 'expired', ...(plan ? { plan } : {}), message: 'Claude Code’s sign-in token has expired; it refreshes the next time Claude Code runs.' };
  }
  let res: Response;
  try {
    res = await deps.fetchImpl(CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ...base, status: 'error', ...(plan ? { plan } : {}), message: 'Could not reach api.anthropic.com.' };
  }
  if (res.status === 401) {
    return { ...base, status: 'expired', ...(plan ? { plan } : {}), message: 'Anthropic refused the stored sign-in; it refreshes the next time Claude Code runs.' };
  }
  if (!res.ok) return { ...base, status: 'error', ...(plan ? { plan } : {}), message: `Claude usage API answered HTTP ${res.status}.` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ...base, status: 'error', ...(plan ? { plan } : {}), message: 'Claude usage API returned an unreadable body.' };
  }
  const { windows, notes } = parseClaudeUsage(body);
  if (!windows.length) return { ...base, status: 'error', ...(plan ? { plan } : {}), notes, message: 'Claude usage API returned no usage windows.' };
  return { ...base, status: 'ok', ...(plan ? { plan } : {}), windows, notes };
}
