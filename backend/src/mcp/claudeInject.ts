// Shaping the resolved server set into Claude Code's `mcpServers` object and
// reconciling it into a `~/.claude.json` project entry without clobbering the
// user's own MCP entries.
//
// Why reconcile and not blind-append (MCP plan §9): some day we may write into
// a project entry that the user's own `claude` sessions also read. We tag the
// servers Lattice manages (a sibling `__latticeManagedMcp` name list on the
// project entry) so each spawn can add currently-enabled Lattice servers and
// strip ones we previously added that are now disabled — leaving anything the
// user added by hand untouched. For Lattice's own spawns the cwd is always an
// ephemeral worktree/scratch dir, so this is belt-and-suspenders, but it keeps
// the one code path correct everywhere.

// Claude's per-server config shape (stdio or http/sse).
export type ClaudeMcpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

// Sibling marker on a `~/.claude.json` project entry listing the server names
// Lattice currently manages there. Unknown keys round-trip through Claude.
export const MANAGED_MCP_MARKER = '__latticeManagedMcp';

// Windows can't `spawn('npx', …)` directly — the package-runner shims are
// `.cmd`/`.ps1` files and the MCP SDK spawns without a shell, so it ENOENTs.
// Wrap the known runners in `cmd /c` on win32; everything else is passed
// through. Node is a real `.exe` and needs no wrapping.
const WIN_SHIM_COMMANDS = new Set(['npx', 'npm', 'pnpm', 'pnpx', 'yarn', 'bunx', 'uvx', 'uv']);

export function platformizeCommand(
  command: string,
  args: string[] = [],
): { command: string; args: string[] } {
  if (process.platform === 'win32' && WIN_SHIM_COMMANDS.has(command.toLowerCase())) {
    return { command: 'cmd', args: ['/c', command, ...args] };
  }
  return { command, args };
}

// Reconcile `managed` (server name → config) into a Claude project entry's
// `mcpServers`, in place. `entry` is mutated (its mcpServers + marker rewritten).
export function reconcileMcpServers(
  entry: Record<string, unknown>,
  managed: Record<string, ClaudeMcpServerConfig>,
): void {
  const prevRaw = entry[MANAGED_MCP_MARKER];
  const prevManaged: string[] = Array.isArray(prevRaw)
    ? (prevRaw.filter((n) => typeof n === 'string') as string[])
    : [];

  const current = { ...((entry.mcpServers as Record<string, unknown>) ?? {}) };

  // Drop servers we previously managed that are no longer enabled. The user's
  // own entries (never in prevManaged) are left alone.
  for (const name of prevManaged) {
    if (!(name in managed)) delete current[name];
  }
  // Upsert the currently-enabled managed servers.
  for (const [name, cfg] of Object.entries(managed)) {
    current[name] = cfg;
  }

  entry.mcpServers = current;
  const names = Object.keys(managed);
  if (names.length > 0) {
    entry[MANAGED_MCP_MARKER] = names;
  } else {
    // Nothing managed anymore — drop the marker so a clean entry stays clean.
    delete entry[MANAGED_MCP_MARKER];
  }
}
