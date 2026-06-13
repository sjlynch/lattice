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
  // Namespaced session id (`push:<id>`, `wf:<runId>:<step>`, `pmh:<id>`) —
  // also the graph node key, so it never collides with a task id.
  agentId: string;
  projectPath: string;
  label: string;
  startedAt: number;
};

type Listener = (projectPath: string, sessions: AgentSession[]) => void;

const sessions = new Map<string, AgentSession>();
const listeners = new Set<Listener>();

// Safety net only — normal teardown is the completion callback. Sized well
// above any realistic non-worktree session runtime.
const MAX_AGE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function listAgentSessions(projectPath: string): AgentSession[] {
  const canonical = canonicalProjectPath(projectPath);
  return [...sessions.values()].filter((s) => s.projectPath === canonical);
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
}): void {
  const projectPath = canonicalProjectPath(input.projectPath);
  sessions.set(input.agentId, {
    agentId: input.agentId,
    projectPath,
    label: input.label,
    startedAt: Date.now(),
  });
  ensureSweepTimer();
  emit(projectPath);
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
    const cutoff = Date.now() - MAX_AGE_MS;
    const staleProjects = new Set<string>();
    for (const [id, s] of sessions) {
      if (s.startedAt < cutoff) {
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
