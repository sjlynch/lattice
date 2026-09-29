import { resolveManagedClaudeServers } from '../mcp/registry.js';
import {
  prepareClaudeSystemPrompt,
  type ClaudeSystemPromptFiles,
} from '../harnessSystemPrompts.js';
import {
  withClaudeStrictMcpFlags,
  writeClaudeStrictMcpConfig,
} from '../mcp/taskWorktreeScope.js';
import type { ClaudeMcpServerConfig } from '../mcp/claudeInject.js';
import type { UserSettings } from '../userSettings.js';
import type { CreateSessionOptions, SessionWireBody, SpawnContext } from './spawnTypes.js';

export async function resolveClaudeSpawn(
  opts: CreateSessionOptions & { cwd: string },
  settings: UserSettings,
  { latticeOnly, mcpCtx, promptExtra }: SpawnContext,
): Promise<SessionWireBody> {
  // No projectPath → trust-only seed (managed: null) + Claude's default memory.
  const managedMcpServers = opts.projectPath
    ? await resolveManagedClaudeServers(
        opts.projectPath,
        { ...mcpCtx, isQaRun: opts.isQaRun },
        settings,
      )
    : null;
  const disableClaudeMemory = opts.projectPath
    ? settings.disableClaudeMemory !== false
    : false;
  const sysPrompt: ClaudeSystemPromptFiles = opts.projectPath
    ? await prepareClaudeSystemPrompt(opts.projectPath, promptExtra).catch(() => ({}))
    : {};
  const initialCommand = latticeOnly && managedMcpServers && opts.projectPath
    ? await withStrictClaudeMcp(opts, opts.projectPath, managedMcpServers)
    : opts.initialCommand;
  return {
    ...opts,
    initialCommand,
    managedMcpServers,
    disableClaudeMemory,
    ...(sysPrompt.replaceFile
      ? { claudeSystemPromptReplaceFile: sysPrompt.replaceFile }
      : {}),
    ...(sysPrompt.appendFile
      ? { claudeSystemPromptAppendFile: sysPrompt.appendFile }
      : {}),
  };
}

// Add `--strict-mcp-config --mcp-config=<file>` to a scoped Claude command so
// only the lattice-only set loads (user-scope and `.mcp.json` servers are
// ignored). Best-effort: on any failure the command is returned unchanged —
// the `projects[<cwd>]` reconcile still carries the lattice-only set.
async function withStrictClaudeMcp(
  opts: CreateSessionOptions,
  projectPath: string,
  servers: Record<string, ClaudeMcpServerConfig>,
): Promise<string | undefined> {
  const command = opts.initialCommand;
  if (!command || !opts.cwd) return command;
  try {
    const file = await writeClaudeStrictMcpConfig(
      projectPath, { taskId: opts.taskId, cwd: opts.cwd }, servers,
    );
    const scoped = withClaudeStrictMcpFlags(command, file);
    if (scoped === null) {
      console.warn(`[mcp] task-worktree scope: left ${opts.cwd} unscoped (flags present or unquotable path ${file})`);
      return command;
    }
    return scoped;
  } catch (err) {
    console.warn(`[mcp] task-worktree scope: could not write the Claude MCP config: ${(err as Error).message}`);
    return command;
  }
}
