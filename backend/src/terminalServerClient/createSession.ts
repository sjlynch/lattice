import {
  BASE,
  ensureTerminalServer,
  probeTerminalServer,
} from '../terminalServerLifecycle.js';
import { terminalServerAuthHeaders } from '../terminalServerAuth.js';
import { randomUUID } from 'node:crypto';
import type { TerminalServerInfo } from '../terminalProtocol.js';
import { assignHarnessSessionId } from '../terminalRegistry/sessionIdentity.js';
import { scheduleCodexDiscovery } from '../terminalRegistry/codexDiscovery.js';
import type { AgentSessionRef } from '../terminalRegistry/types.js';
import { trackRestartTransition } from '../restartDrain/gate.js';
import {
  resolveHarnessSpawnBody,
  type CreateSessionOptions,
  type SessionWireBody,
} from './spawnBody.js';
import { recordSpawnedTerminal } from './recordSpawn.js';

// Per-harness spawn-body resolution lives in spawnBody.ts and registry
// recording in recordSpawn.ts; these stay importable from here.
export { resolveHarnessSpawnBody };
export type { CreateSessionOptions, SessionWireBody };

// Hard timeout on a single POST /sessions. Generous on purpose: a normal pty
// pre-create is sub-second, but under a heavy "Run All" burst the trust-seed
// file I/O on the shared ~/.claude.json plus the conpty spawn can legitimately
// take a few seconds, so anything under ~30s would risk aborting a spawn that
// was about to succeed. Past that, the request is almost certainly WEDGED (a
// stuck conpty handle or a black-holed socket to :5185), and we must not wait
// on it forever: the spawn queue holds a concurrency reservation for the WHOLE
// spawn thunk and only reclaims it once this call settles, so an un-timed hang
// here permanently leaks a slot and silently lowers the effective agent cap
// below the configured `maxConcurrentAgents` (the "Run All gave me 15 of 24"
// symptom). Bounding the call guarantees the thunk always settles and the slot
// is always returned to the queue.
const CREATE_SESSION_TIMEOUT_MS = 30_000;

// `code: 'CAP'` ⇒ the failure was the terminal-server's hard session cap.
// The spawn queue keys its over-admit back-off on this; any other failure
// is a genuine error.
export type CreateSessionResult =
  | {
      id: string;
      // The durable registry tab id (`TerminalRecord.id`); the frontend uses
      // it as the tab's own id so a restore rebuilds the same tab.
      terminalId?: string;
      // The harness conversation this pty runs, when Lattice pinned one.
      agentSession?: AgentSessionRef;
    }
  | { error: string; code?: 'CAP' };

type CreateOnce =
  | { id: string }
  | { error: string; recoverable: boolean; code?: 'CAP' };

// Pre-create a pty session in the terminal-server subprocess. Returns the
// session id so route handlers can include it in their response and the
// frontend can attach via that id later (instead of triggering creation by
// opening a WS).
//
// Retry only when the same executor advertises request deduplication. A lost
// response can mean the PTY already exists; replaying into a legacy/replacement
// server could start the agent twice. A broken request never tears down peers.
//
// Every create is a restart-drain transition (../restartDrain/): a restart
// landing between the executor spawning the pty and the registry record /
// caller bookkeeping being written would leave a live agent nobody tracks.
export function proxyCreateSession(
  opts: CreateSessionOptions,
): Promise<CreateSessionResult> {
  return trackRestartTransition('terminal create', createSessionTracked(opts));
}

async function createSessionTracked(
  opts: CreateSessionOptions,
): Promise<CreateSessionResult> {
  let server: TerminalServerInfo;
  try { server = await ensureTerminalServer(); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  const canRetry = server.capabilities?.idempotentCreate === true && !!server.instanceId;
  // Pin the harness conversation id before the command reaches the executor
  // (Claude / Pi `--session-id`), so a later relaunch can resume it. The
  // registry keeps the ORIGINAL command; the wire carries the pinned one.
  const { registry: _registry, ...wireOpts } = opts;
  const identity = assignHarnessSessionId(opts.initialCommand);
  const spawnOpts: CreateSessionOptions = identity.agentSession
    ? { ...wireOpts, initialCommand: identity.command }
    : wireOpts;
  const body: SessionWireBody = {
    ...await resolveHarnessSpawnBody(spawnOpts),
    ...(canRetry ? { requestId: randomUUID(), requestTimestamp: Date.now(), serverInstanceId: server.instanceId } : {}),
  };
  const finish = async (id: string): Promise<CreateSessionResult> => {
    const record = await recordSpawnedTerminal(
      opts, opts.initialCommand, id, server.instanceId, identity.agentSession,
    );
    if (record?.launch.harness === 'codex' && !record.agentSession) {
      scheduleCodexDiscovery(record.id, record.projectPath);
    }
    return {
      id,
      ...(record ? { terminalId: record.id } : {}),
      ...(record?.agentSession ? { agentSession: record.agentSession } : {}),
    };
  };
  const first = await tryCreateSessionOnce(body);
  if ('id' in first) return finish(first.id);
  if (!first.recoverable) return { error: first.error, code: first.code };
  const uncertain = `${first.error}. Session creation outcome is unknown; it was not replayed to avoid starting a duplicate agent.`;
  if (!canRetry) return { error: uncertain };
  const current = await probeTerminalServer();
  if (current.kind !== 'ready' || current.info.instanceId !== server.instanceId
      || !current.info.capabilities?.idempotentCreate) return { error: uncertain };
  const retry = await tryCreateSessionOnce(body);
  if ('id' in retry) return finish(retry.id);
  return { error: retry.recoverable
    ? `${retry.error}. Session creation outcome remains unknown after the bounded retry.`
    : retry.error, code: retry.code };
}

export async function tryCreateSessionOnce(
  body: SessionWireBody,
): Promise<CreateOnce> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...terminalServerAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CREATE_SESSION_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return {
      error: name === 'TimeoutError' || name === 'AbortError'
        ? `terminal-server did not respond within ${CREATE_SESSION_TIMEOUT_MS}ms`
        : err instanceof Error ? err.message : String(err),
      // Even a timeout can follow successful allocation. The caller retries
      // only against this same executor with the same deduplicated request ID.
      recoverable: true,
    };
  }
  const text = await res.text().catch(() => '');
  type SessionBody = { id?: string; error?: string; code?: 'CAP' };
  let parsed: SessionBody | null = null;
  try {
    parsed = text ? (JSON.parse(text) as SessionBody) : null;
  } catch {
    // HTML / plain-text body → almost certainly a stale terminal-server
    // (missing route) or a wrong process bound to the port.
    const preview = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    return {
      error: `terminal-server returned non-JSON (status ${res.status}): ${preview}`,
      recoverable: true,
    };
  }
  if (res.ok && (!parsed || typeof parsed.id !== 'string' || !parsed.id)) {
    return { error: `terminal-server returned an invalid session response (status ${res.status})`, recoverable: true };
  }
  if (!res.ok) {
    return {
      error: typeof parsed?.error === 'string' ? parsed.error : `terminal-server ${res.status}`,
      recoverable: false,
      code: parsed?.code === 'CAP' ? 'CAP' : undefined,
    };
  }
  return { id: parsed!.id! };
}
