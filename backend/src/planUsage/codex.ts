// Codex (ChatGPT plan) usage: the rate-limit windows Codex's /status shows.
//
// Live: `codex app-server` over JSON-RPC (initialize → account/rateLimits/read)
// — Codex's own sign-in, no model call, nothing written. Fallback when the CLI
// is missing or doesn't answer: the newest `rate_limits` snapshot Codex wrote
// into a session rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`),
// reported with its own timestamp so a stale snapshot reads as one.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { killChildTree } from '../processTree.js';
import type { PlanUsageProvider, PlanUsageWindow } from './types.js';

export type CodexUsageDeps = {
  appServerRateLimits: () => Promise<unknown>;
  latestSnapshot: () => Promise<{ at: string; rateLimits: unknown } | null>;
  now: () => number;
};

const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

// 300 → "5-hour", 10080 → "Week", 1440 → "Day", other → "<n>-minute".
export function codexWindowLabel(minutes: number | undefined): string {
  if (minutes === 10080) return 'Week';
  if (minutes === 1440) return 'Day';
  if (minutes && minutes % 60 === 0) return `${minutes / 60}-hour`;
  return minutes ? `${minutes}-minute` : 'Window';
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(+v) ? +v : undefined);

// Accepts both shapes: app-server camelCase (`usedPercent`, `windowDurationMins`,
// `resetsAt`) and the rollout's snake_case (`used_percent`, `window_minutes`,
// `resets_at`); `resetsAt` is epoch seconds in both.
export function parseCodexRateLimits(raw: unknown, extra?: { resetCredits?: unknown }): { windows: PlanUsageWindow[]; notes: string[]; plan?: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const windows: PlanUsageWindow[] = [];
  for (const id of ['primary', 'secondary'] as const) {
    const w = r[id] as Record<string, unknown> | null | undefined;
    const used = num(w?.usedPercent ?? w?.used_percent);
    if (!w || used === undefined) continue;
    const minutes = num(w.windowDurationMins ?? w.window_minutes);
    const resets = num(w.resetsAt ?? w.resets_at);
    windows.push({
      id,
      label: codexWindowLabel(minutes),
      usedPercent: used,
      ...(minutes !== undefined ? { windowMinutes: minutes } : {}),
      ...(resets !== undefined ? { resetsAt: new Date(resets * 1000).toISOString() } : {}),
    });
  }
  const notes: string[] = [];
  const credits = r.credits as Record<string, unknown> | null | undefined;
  if (credits?.unlimited === true) notes.push('Unlimited credits');
  else if (credits && (credits.hasCredits ?? credits.has_credits) === true) {
    const bal = num(credits.balance);
    if (bal !== undefined) notes.push(`Credits balance ${Math.floor(bal).toLocaleString('en-US')}: past a limit, usage draws on credits`);
  }
  if ((r.spendControlReached ?? r.spend_control_reached) === true) notes.push('Spend control reached');
  const reached = r.rateLimitReachedType ?? r.rate_limit_reached_type;
  if (typeof reached === 'string' && reached) notes.push(`Limit reached: ${reached}`);
  const rc = (extra?.resetCredits ?? null) as { availableCount?: unknown } | null;
  const free = num(rc?.availableCount);
  if (free) notes.push(`${free} free rate-limit reset${free === 1 ? '' : 's'} available (in Codex)`);
  const planType = r.planType ?? r.plan_type;
  const plan = typeof planType === 'string' && planType ? planType[0].toUpperCase() + planType.slice(1) : undefined;
  return { windows, notes, ...(plan ? { plan } : {}) };
}

// One short-lived `codex app-server`: initialize, then account/rateLimits/read.
// Resolves the read's `result`; rejects on spawn error, an RPC error or 20 s.
export function readRateLimitsViaAppServer(timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const shell = process.platform === 'win32'; // resolves codex.cmd; args are static
    let child;
    try {
      // Through a shell the command is one static string (no args array: DEP0190).
      child = shell
        ? spawn('codex app-server', { shell, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
        : spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let buf = '';
    let settled = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* closed */ }
      killChildTree(child, { shell });
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server did not answer')), timeoutMs);
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    child.on('error', (err) => finish(err));
    child.on('close', () => finish(new Error('codex app-server exited')));
    child.stdin.on('error', () => { /* reported via close */ });
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return finish(new Error('codex app-server refused initialize'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2) {
          if (m.error) return finish(new Error(String(m.error.message ?? 'rate limits unavailable')));
          return finish(null, m.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lattice', version: '1.0.0' } } });
  });
}

// Newest `rate_limits` snapshot in the last 14 days of rollouts: day dirs
// newest first, files newest first (first 30), the tail 512 KB of each.
export async function readLatestRolloutSnapshot(root = path.join(codexHome(), 'sessions')): Promise<{ at: string; rateLimits: unknown } | null> {
  const days: string[] = [];
  const list = async (dir: string) => (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => /^\d+$/.test(n)).sort().reverse();
  for (const y of await list(root)) {
    for (const m of await list(path.join(root, y))) {
      for (const d of await list(path.join(root, y, m))) {
        days.push(path.join(root, y, m, d));
        if (days.length >= 14) break;
      }
      if (days.length >= 14) break;
    }
    if (days.length >= 14) break;
  }
  for (const day of days) {
    const names = (await fs.readdir(day).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl'));
    const stats = await Promise.all(names.map(async (n) => ({ n, t: (await fs.stat(path.join(day, n)).catch(() => null))?.mtimeMs ?? 0 })));
    for (const { n } of stats.sort((a, b) => b.t - a.t).slice(0, 30)) {
      const text = await readTail(path.join(day, n), 512 * 1024);
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"rate_limits"')) continue;
        try {
          const e = JSON.parse(lines[i]) as { timestamp?: unknown; payload?: { rate_limits?: unknown } };
          if (e.payload?.rate_limits && typeof e.timestamp === 'string') return { at: e.timestamp, rateLimits: e.payload.rate_limits };
        } catch { /* a partial first line */ }
      }
    }
  }
  return null;
}

async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await fs.open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, bytes);
    const b = Buffer.alloc(len);
    await fh.read(b, 0, len, size - len);
    return b.toString('utf8');
  } finally {
    await fh.close();
  }
}

const defaultDeps = (): CodexUsageDeps => ({
  appServerRateLimits: () => readRateLimitsViaAppServer(),
  latestSnapshot: () => readLatestRolloutSnapshot(),
  now: Date.now,
});

export async function readCodexUsage(deps: CodexUsageDeps = defaultDeps()): Promise<PlanUsageProvider> {
  const asOf = new Date(deps.now()).toISOString();
  try {
    const result = (await deps.appServerRateLimits()) as { rateLimits?: unknown; rateLimitResetCredits?: unknown } | null;
    if (result?.rateLimits) {
      const { windows, notes, plan } = parseCodexRateLimits(result.rateLimits, { resetCredits: result.rateLimitResetCredits });
      if (windows.length) return { provider: 'codex', status: 'ok', ...(plan ? { plan } : {}), windows, notes, source: 'Codex app-server', asOf };
    }
  } catch { /* fall back to the newest snapshot */ }
  const snap = await deps.latestSnapshot().catch(() => null);
  if (snap) {
    const { windows, notes, plan } = parseCodexRateLimits(snap.rateLimits);
    if (windows.length) {
      return { provider: 'codex', status: 'ok', ...(plan ? { plan } : {}), windows, notes, source: 'Codex session log (last snapshot)', asOf: snap.at };
    }
  }
  return { provider: 'codex', status: 'unavailable', windows: [], notes: [], source: 'Codex app-server', asOf, message: 'Codex didn’t report usage: is it installed and signed in with ChatGPT (`codex login`)?' };
}
