import { fetchGlobalSettings, patchGlobalSettings, type McpServerEntry } from '../../../api';

// Custom-server definitions are machine-global (`globalSettings.mcpCustomServers`)
// and persist immediately, not with the dialog footer. Both edits re-read the
// current list so a concurrent change elsewhere isn't overwritten wholesale.
async function rewriteCustomServers(
  update: (customs: McpServerEntry[]) => McpServerEntry[],
): Promise<void> {
  const global = await fetchGlobalSettings();
  await patchGlobalSettings({ mcpCustomServers: update(global.mcpCustomServers ?? []) });
}

// Add `entry`, replacing any existing custom server with the same id (moved to the end).
export function upsertCustomServer(entry: McpServerEntry): Promise<void> {
  return rewriteCustomServers((customs) => [
    ...customs.filter((c) => c.id !== entry.id),
    entry,
  ]);
}

export function removeCustomServer(id: string): Promise<void> {
  return rewriteCustomServers((customs) => customs.filter((c) => c.id !== id));
}
