import { applyPiMcpForSpawn } from '../piMcp.js';
import { preparePiSystemPrompt } from '../harnessSystemPrompts.js';
import type { UserSettings } from '../userSettings.js';
import type { CreateSessionOptions, SessionWireBody, SpawnContext } from './spawnTypes.js';

export async function resolvePiSpawn(
  opts: CreateSessionOptions & { cwd: string; projectPath: string },
  settings: UserSettings,
  { mcpCtx, promptExtra }: SpawnContext,
): Promise<SessionWireBody> {
  const env = await applyPiMcpForSpawn(opts.cwd, opts.projectPath, mcpCtx, settings);
  // Reconcile the Pi system-prompt extension in the cwd (installs it when
  // there's an override, strips a stale one otherwise). Cwd-local files, so
  // nothing rides the wire — like the MCP shim.
  await preparePiSystemPrompt(opts.cwd, opts.projectPath, promptExtra).catch(() => {});
  if (Object.keys(env).length > 0) return { ...opts, managedMcpEnv: env };
  return opts;
}
