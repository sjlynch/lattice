import { createHash } from 'node:crypto';
import {
  SESSION_REQUEST_FUTURE_SKEW_MS,
  SESSION_REQUEST_MAX_AGE_MS,
  SESSION_REQUEST_RETENTION_MS,
  type SessionRequestIdentity,
} from '../terminalProtocol.js';

export type SessionRequestResult = { id: string } | { error: string; code?: 'CAP' };
type Entry = { hash: string; result: Promise<SessionRequestResult>; completedAt?: number };

/** Dedupe concurrent/lost-response retries without storing spawn payload secrets. */
export function createSessionRequestRegistry({ now = Date.now, maxEntries = 4096 } = {}) {
  const entries = new Map<string, Entry>();
  return async (
    body: SessionRequestIdentity,
    create: () => Promise<SessionRequestResult>,
  ): Promise<SessionRequestResult> => {
    if (body.requestId === undefined) return create(); // legacy client
    const timestamp = body.requestTimestamp;
    const time = now();
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.requestId)
        || typeof timestamp !== 'number' || !Number.isFinite(timestamp)
        || timestamp < time - SESSION_REQUEST_MAX_AGE_MS
        || timestamp > time + SESSION_REQUEST_FUTURE_SKEW_MS) {
      return { error: 'terminal-server: invalid or expired session request identity' };
    }
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const existing = entries.get(body.requestId);
    if (existing) {
      return existing.hash === hash ? existing.result
        : { error: 'terminal-server: session request ID reused with different options' };
    }
    // A valid request cannot outlive retention, so pruning completed entries
    // never makes an old request eligible to execute again. Pending entries are
    // retained even if slow; pressure refuses admission instead of evicting one.
    for (const [id, entry] of entries) {
      if (entry.completedAt !== undefined && entry.completedAt < time - SESSION_REQUEST_RETENTION_MS) entries.delete(id);
    }
    if (entries.size >= maxEntries) return { error: 'terminal-server: session request registry is full; retry later' };
    const entry: Entry = { hash, result: Promise.resolve().then(create).catch((error: unknown) => ({
      error: `terminal-server: ${error instanceof Error ? error.message : String(error)}`,
    })) };
    // Publish the promise before any async config write / PTY allocation.
    entries.set(body.requestId, entry);
    void entry.result.then(() => { entry.completedAt = now(); });
    return entry.result;
  };
}
