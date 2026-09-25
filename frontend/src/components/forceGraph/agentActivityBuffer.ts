// Short-lived holding pen for activity frames addressed to an agent whose node
// isn't on screen YET.
//
// A terminal agent's node is created by its first activity (backend
// projectClaude/lifecycle.ts), and the two halves of that moment travel on
// different sockets: the new session on `/ws/agent-sessions`, the file it
// touched on `/ws/tasks`. When the file frame wins the race the overlay has no
// node to hang it on, and dropping it left a bare dot with no label or beam —
// often for the whole turn, since a quick read is a single tool use. So a frame
// for an unknown agent is held here and replayed the moment its node appears.
// Frames for an agent that never appears (a task that isn't in progress, a
// session outside this project) just age out.

export const PENDING_ACTIVITY_TTL_MS = 10_000;
export const PENDING_ACTIVITY_PER_AGENT = 32;
export const PENDING_ACTIVITY_AGENTS = 64;

type Pending<E> = { events: E[]; at: number };

export class PendingActivityBuffer<E> {
  private readonly byAgent = new Map<string, Pending<E>>();

  add(agentId: string, event: E, now: number): void {
    this.prune(now);
    let entry = this.byAgent.get(agentId);
    if (!entry) {
      // Bounded: evict the oldest agent's frames rather than grow forever.
      if (this.byAgent.size >= PENDING_ACTIVITY_AGENTS) {
        const oldest = this.byAgent.keys().next().value;
        if (oldest !== undefined) this.byAgent.delete(oldest);
      }
      entry = { events: [], at: now };
      this.byAgent.set(agentId, entry);
    }
    entry.events.push(event);
    if (entry.events.length > PENDING_ACTIVITY_PER_AGENT) entry.events.shift();
    entry.at = now;
  }

  // Every agent with frames still waiting.
  agentIds(): string[] {
    return [...this.byAgent.keys()];
  }

  // Remove and return an agent's frames, oldest first ([] once expired).
  take(agentId: string, now: number): E[] {
    const entry = this.byAgent.get(agentId);
    if (!entry) return [];
    this.byAgent.delete(agentId);
    return now - entry.at > PENDING_ACTIVITY_TTL_MS ? [] : entry.events;
  }

  clear(): void {
    this.byAgent.clear();
  }

  private prune(now: number): void {
    for (const [id, entry] of this.byAgent) {
      if (now - entry.at > PENDING_ACTIVITY_TTL_MS) this.byAgent.delete(id);
    }
  }
}
