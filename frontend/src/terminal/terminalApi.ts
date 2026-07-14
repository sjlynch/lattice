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

// Pre-create a backend pty session through the main backend's spawn chokepoint
// (POST /api/terminals → proxyCreateSession → resolveHarnessSpawnBody) and
// return its serverId, so a harness terminal's MCP config is resolved + applied
// (Codex `-c` args, Pi `<cwd>/.pi/mcp.json`) BEFORE the pty spawns. Attaching by
// the returned id is what routes a sidebar Codex/Pi launch through the same path
// tasks use; a serverless `/ws/terminal` connect bypasses it entirely.
//
// Returns null on ANY failure (backend unreachable, at capacity, malformed
// reply) so the caller can fall back to a serverless connect — no worse than
// the old behaviour, and a plain terminal never needs this at all.
export async function createBackendSession(opts: {
  cwd: string;
  initialCommand?: string;
  projectPath?: string;
}): Promise<string | null> {
  try {
    const r = await fetch('/api/terminals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    if (!r.ok) return null;
    const data = (await r.json()) as { id?: unknown };
    return typeof data.id === 'string' ? data.id : null;
  } catch {
    return null;
  }
}
