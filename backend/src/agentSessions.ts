// Presence registry for Claude sessions that run OUTSIDE a task worktree
// (push runs, workflow steps, post-merge hooks). Drives the orange "Claude
// node" on the graph: a node appears when the session is registered (at
// spawn) and disappears when it is unregistered (at its completion callback).
//
// Kept separate from `agentActivity.ts` (which carries the per-file focus
// beams): presence answers "is this session alive?", activity answers "what
// file is it touching?". A session with no file activity (e.g. a pure-git
// push run) still gets a node from the registry.
//
// Cleanup: the completion callbacks (`/done`, step `/complete`, post-merge
// `/complete`) are the normal unregister signal and are triple-backstopped
// (Stop hook + Pi extension + explicit curl). A lazy age sweep is the safety
// net for a session that dies abnormally without firing any callback.

import { canonicalProjectPath } from './projectPath.js';

export type AgentSession = {
  // Namespaced session id (`push:<id>`, `wf:<runId>:<step>`, `pmh:<id>`, or
  // `claude:<session_id>` for a project-instrumented session) — also the
  // graph node key, so it never collides with a task id.
  agentId: string;
  projectPath: string;
  label: string;
  startedAt: number;
};

// Internal record carries liveness metadata not sent to the frontend.
type SessionRecord = AgentSession & {
  // Last time we saw any signal from this session (register or activity).
  lastSeen: number;
  // When set, the session is expired after this many ms with no signal —
  // used by project-instrumented sessions (lazy presence, may miss
  // SessionEnd). Lifecycle sessions (push/wf/pmh) leave this undefined and
  // rely on their completion callback + the absolute age safety.
  idleTtlMs?: number;
};

type Listener = (projectPath: string, sessions: AgentSession[]) => void;

const sessions = new Map<string, SessionRecord>();
const listeners = new Set<Listener>();

// Absolute safety net for lifecycle sessions whose completion callback never
// fired. Measured from `lastSeen` (silence), NOT `startedAt` (age): an active
// session refreshes `lastSeen` on every activity event (routes/agentActivity.ts
// → touchAgentSession), so this only reaps a session that has gone fully quiet
// — a long-but-active one (a substantial workflow step, a thorough QA run whose
// first launch downloads browsers, a large push) is never swept mid-run.
const MAX_AGE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function publicView(r: SessionRecord): AgentSession {
  return {
    agentId: r.agentId,
    projectPath: r.projectPath,
    label: r.label,
    startedAt: r.startedAt,
  };
}

export function listAgentSessions(projectPath: string): AgentSession[] {
  const canonical = canonicalProjectPath(projectPath);
  return [...sessions.values()]
    .filter((s) => s.projectPath === canonical)
    .map(publicView);
}

export function subscribeAgentSessions(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(projectPath: string): void {
  const list = listAgentSessions(projectPath);
  for (const listener of [...listeners]) {
    try {
      listener(projectPath, list);
    } catch (err) {
      console.error('[agent-sessions] listener threw:', err);
    }
  }
}

export function registerAgentSession(input: {
  agentId: string;
  projectPath: string;
  label: string;
  idleTtlMs?: number;
}): void {
  const now = Date.now();
  const existing = sessions.get(input.agentId);
  if (existing) {
    // Already present (e.g. a tool-use after SessionStart) — just refresh
    // liveness. No re-emit: the node is already on the graph and its
    // startedAt/label shouldn't change.
    existing.lastSeen = now;
    return;
  }
  const projectPath = canonicalProjectPath(input.projectPath);
  sessions.set(input.agentId, {
    agentId: input.agentId,
    projectPath,
    label: input.label,
    startedAt: now,
    lastSeen: now,
    idleTtlMs: input.idleTtlMs,
  });
  ensureSweepTimer();
  emit(projectPath);
}

// Refresh a session's liveness without creating one. Returns whether it
// existed. Used by the project-activity route on each tool-use so an active
// session never idle-expires.
export function touchAgentSession(agentId: string): boolean {
  const existing = sessions.get(agentId);
  if (!existing) return false;
  existing.lastSeen = Date.now();
  return true;
}

export function unregisterAgentSession(agentId: string): void {
  const existing = sessions.get(agentId);
  if (!existing) return;
  sessions.delete(agentId);
  emit(existing.projectPath);
}

function ensureSweepTimer(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    const staleProjects = new Set<string>();
    for (const [id, s] of sessions) {
      // Both conditions key off `lastSeen`, so ongoing activity always wins:
      // an explicit idle TTL (project-instrumented sessions, lazy presence) OR
      // the absolute MAX_AGE_MS silence backstop (lifecycle sessions). The
      // backstop is staleness, not age — a long-but-active session keeps
      // refreshing `lastSeen` and is never reaped while alive.
      const idleExpired =
        s.idleTtlMs !== undefined && now - s.lastSeen > s.idleTtlMs;
      const staleExpired = now - s.lastSeen > MAX_AGE_MS;
      if (idleExpired || staleExpired) {
        sessions.delete(id);
        staleProjects.add(s.projectPath);
      }
    }
    for (const p of staleProjects) emit(p);
    if (sessions.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Don't keep the process alive just for the sweep.
  sweepTimer.unref?.();
}
