import { resolveManagedCodexServers } from '../mcp/registry.js';
import { prepareCodexSystemPrompt } from '../harnessSystemPrompts.js';
import { codexUserServerDisableArgs } from '../mcp/taskWorktreeScope.js';
import { resolveDefaultShell } from '../terminal/launchContext.js';
import { getBackendServerConfig } from '../server/config.js';
import {
  projectCodexHookConfigArgs,
  wantsProjectCodexHooks,
  withCodexHookTrustBypass,
} from '../projectCodexHooks.js';
import type { UserSettings } from '../userSettings.js';
import type { CreateSessionOptions, SessionWireBody, SpawnContext } from './spawnTypes.js';

export async function resolveCodexSpawn(
  opts: CreateSessionOptions & { cwd: string; projectPath: string },
  settings: UserSettings,
  { latticeOnly, mcpCtx, promptExtra }: SpawnContext,
): Promise<SessionWireBody> {
  const codex = await resolveManagedCodexServers(opts.projectPath, mcpCtx, settings);
  // The pty shell the terminal-server will pick (no per-spawn shell rides
  // this body, and it inherits this process's LATTICE_DEFAULT_SHELL/COMSPEC),
  // so the Append is flattened only where cmd.exe's `"%VAR%"` needs it.
  const sysPrompt = await prepareCodexSystemPrompt(
    opts.projectPath,
    promptExtra,
    resolveDefaultShell(),
  ).catch(
    () => ({ configArgs: [] as string[] }),
  );
  // Scoped: switch off the user's own config.toml servers first, then add
  // the lattice one (see taskWorktreeScope.ts for why not `mcp_servers={}`).
  // Skipped when the resolve failed — that degrades to a plain spawn.
  const disableArgs = latticeOnly && codex
    ? await codexUserServerDisableArgs(opts.cwd, managedCodexKeys(codex.configArgs)).catch(
        () => [] as string[],
      )
    : [];
  // A user-launched project session gets the graph-activity hooks (the
  // Codex analogue of the project's `.claude/settings.local.json` hooks) as
  // extra `-c` overrides on the same channel — see projectCodexHooks.ts.
  const activityHooks = wantsProjectCodexHooks({
    cwd: opts.cwd,
    projectPath: opts.projectPath,
    owner: opts.registry?.owner,
    instrumentProjectSessions: settings.instrumentProjectClaudeSessions,
  });
  const hookArgs = activityHooks
    ? projectCodexHookConfigArgs(getBackendServerConfig().backendOrigin, opts.projectPath)
    : [];
  const mcpArgs = [...disableArgs, ...(codex?.configArgs ?? []), ...hookArgs];
  const env = codex?.env ?? {};
  // Nothing to inject → plain spawn.
  if (mcpArgs.length === 0 && sysPrompt.configArgs.length === 0) return opts;
  return {
    ...opts,
    ...(activityHooks && opts.initialCommand
      ? { initialCommand: withCodexHookTrustBypass(opts.initialCommand) }
      : {}),
    ...(mcpArgs.length > 0 ? { managedCodexConfigArgs: mcpArgs } : {}),
    ...(sysPrompt.configArgs.length > 0
      ? { codexSystemPromptConfigArgs: sysPrompt.configArgs }
      : {}),
    ...(Object.keys(env).length > 0 ? { managedMcpEnv: env } : {}),
  };
}

// The `lattice_*` server keys a resolved Codex override list defines
// (`mcp_servers.<key>={…}`), so the user-server disables never touch them.
function managedCodexKeys(configArgs: string[]): Set<string> {
  const keys = new Set<string>();
  for (const arg of configArgs) {
    const m = /^mcp_servers\.([A-Za-z0-9_-]+)=/.exec(arg);
    if (m) keys.add(m[1]);
  }
  return keys;
}
