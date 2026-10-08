// The terminal-server's memory numbers for the BACKEND's `[mem]` line (the
// executor runs with stdio ignored, so its own line never reaches a console).
// Backend-only. `GET /memory` exists on executors built with memDiag; an older
// executor 404s, and then only the session count from `/sessions` is reported.

import { BASE } from '../terminalServerLifecycle.js';
import { terminalServerAuthHeaders } from '../terminalServerAuth.js';

const TIMEOUT_MS = 1_500;

function finiteNumbers(body: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function getJson(path: string): Promise<unknown | null> {
  const res = await fetch(`${BASE}${path}`, {
    headers: terminalServerAuthHeaders(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // Release the socket now rather than whenever GC finds the body.
    await res.body?.cancel().catch(() => {});
    return null;
  }
  return res.json();
}

export async function readExecutorMemory(): Promise<Record<string, number>> {
  const mem = await getJson('/memory');
  if (mem) return finiteNumbers(mem); // `mem.rss`, `terminal.sessions`, …
  const sessions = await getJson('/sessions');
  return Array.isArray(sessions) ? { 'terminal.sessions': sessions.length } : {};
}
