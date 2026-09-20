// Side-effect helper: tear down a backend pty session. Kept out of the React
// state layer so it cannot accidentally run inside a setState updater — in
// StrictMode dev that would fire twice and DELETE the pty session twice,
// which on Windows previously crashed node-pty's helper subprocess and
// brought the whole backend down.
export function deleteBackendSession(serverId: string): void {
  void fetch(`/api/terminals/${encodeURIComponent(serverId)}`, {
    method: 'DELETE',
  }).catch(() => {
    /* ignore */
  });
}

// The ids of every live pty (`GET /api/terminals`), or null when the list could
// not be read — "can't tell", which callers must never treat as "no sessions".
export async function fetchLiveTerminalIds(): Promise<ReadonlySet<string> | null> {
  try {
    const r = await fetch('/api/terminals');
    if (!r.ok) return null;
    const sessions = (await r.json()) as Array<{ id?: unknown }>;
    if (!Array.isArray(sessions)) return null;
    return new Set(
      sessions.map((s) => s.id).filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
  } catch {
    return null;
  }
}

export type CreatedBackendSession = {
  // The pty session id (attach target).
  serverId: string;
  // The durable registry tab id (see api/types/terminalTabs.ts). Used as the
  // sidebar tab's own id so a restore rebuilds the same tab. Absent only when
  // an older backend answered.
  terminalId?: string;
};

// Pre-create a backend pty session through the main backend's spawn chokepoint
// (POST /api/terminals → proxyCreateSession → resolveHarnessSpawnBody) and
// return its ids, so a harness terminal's MCP config is resolved + applied
// (Codex `-c` args, Pi `<cwd>/.pi/mcp.json`) BEFORE the pty spawns, and the
// tab is recorded in the durable registry (label / owner / startupId ride
// along as its decorations). Attaching by the returned serverId is what routes
// a sidebar Codex/Pi launch through the same path tasks use; a serverless
// `/ws/terminal` connect bypasses both.
//
// Returns null on ANY failure (backend unreachable, at capacity, malformed
// reply) so the caller can fall back to a serverless connect — no worse than
// the old behaviour.
export async function createBackendSession(opts: {
  cwd: string;
  initialCommand?: string;
  projectPath?: string;
  label?: string;
  owner?: 'user' | 'startup';
  startupId?: string;
  piModel?: string;
}): Promise<CreatedBackendSession | null> {
  try {
    const r = await fetch('/api/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { id?: unknown; terminalId?: unknown };
    if (typeof data.id !== 'string') return null;
    return {
      serverId: data.id,
      terminalId: typeof data.terminalId === 'string' ? data.terminalId : undefined,
    };
  } catch {
    return null;
  }
}
