import {
  resolveManagedClaudeServers,
  resolveManagedCodexServers,
  type McpResolveContext,
} from '../mcp/registry.js';
import { applyPiMcpForSpawn } from '../piMcp.js';
import {
  prepareClaudeSystemPrompt,
  prepareCodexSystemPrompt,
  preparePiSystemPrompt,
  type ClaudeSystemPromptFiles,
} from '../harnessSystemPrompts.js';
import {
  getUserSettings,
  taskAgentTypecheckIn,
  taskWorktreeLfsContentIn,
  type UserSettings,
} from '../userSettings.js';
import { lfsCheckoutEnv } from '../worktree/lfsMode.js';
import { gitConfigEnv, NO_AUTO_GC } from '../worktree/gitAutoGc.js';
import { renderVerificationSystemPrompt } from '../taskVerification.js';
import {
  codexUserServerDisableArgs,
  isTaskWorktreeSpawn,
  latticeOnlyMcpApplies,
  withClaudeStrictMcpFlags,
  writeClaudeStrictMcpConfig,
  type McpSpawnScope,
} from '../mcp/taskWorktreeScope.js';
import type { ClaudeMcpServerConfig } from '../mcp/claudeInject.js';
import type { SessionRequestIdentity } from '../terminalProtocol.js';
import { withCodexActivityTitle } from '../codexTerminalActivity.js';
import { resolveDefaultShell } from '../terminal/launchContext.js';
import type { TerminalRegistryHint } from '../terminalRegistry/types.js';
import { refreshLatticeApiDocs } from '../latticeApiDocs.js';
import { getBackendServerConfig } from '../server/config.js';
import {
  projectCodexHookConfigArgs,
  wantsProjectCodexHooks,
  withCodexHookTrustBypass,
} from '../projectCodexHooks.js';

export type CreateSessionOptions = {
  cwd?: string;
  initialCommand?: string;
  projectPath?: string;
  cols?: number;
  rows?: number;
  // Set only by the QA-lane e2e-run spawn. Used HERE (in the backend) to resolve
  // the QA-scoped Playwright (`qaPlaywright`); ordinary spawns omit it and get
  // Playwright only via the global `mcpOverrides.playwright` toggle. Not consumed
  // by the terminal-server itself. See mcp/registry.ts.
  isQaRun?: boolean;
  // Set only by the task run/resume spawns (`routes/tasks/harnessFactory.ts`)
  // and the worktree merge-conflict resolvers (`routes/tasks/mergeResponses.ts`,
  // `mergeRuns/resolverSpawn/spawn.ts`): the task whose worktree this session is. Used HERE to bake `LATTICE_TASK_ID`
  // into the first-party `lattice` MCP server's env, so the worktree agent gets
  // a `my_task` tool and an `append_summary` that defaults to its own task —
  // without having to read its id back out of LATTICE_TASK.md. Like `isQaRun`,
  // it rides the wire body but the terminal-server never reads it.
  taskId?: string;
  // `'task-worktree'` marks a task run/resume or a WORKTREE merge-conflict
  // resolver. With the project's `taskAgentsLatticeMcpOnly` setting on (the
  // default) and a cwd under `~/.lattice/worktrees/`, such a session gets only
  // the Lattice MCP server — see mcp/taskWorktreeScope.ts. Resolved HERE; the
  // terminal-server never reads it. Persisted on the registry record so a
  // relaunched tab keeps it.
  mcpScope?: McpSpawnScope;
  // What the durable terminal registry should record about this pty (who owns
  // the tab, its label, …). Every Lattice spawn site passes one; a missing
  // hint is recorded as a plain user tab so the tab is still restorable. Not
  // shipped to the terminal-server.
  registry?: TerminalRegistryHint;
};

// The POST /sessions wire body: the caller's options plus the spawn-time Claude
// config the BACKEND resolves here, so the detached terminal-server stays a dumb
// executor that only APPLIES this (it never resolves MCP/trust/memory policy
// itself). Threading the resolved config as DATA — instead of having the
// terminal-server import the resolver — is what keeps a spawn-policy change a
// backend-only edit that never forces a terminal-server respawn. See
// claudeTrust.ts / mcp/CLAUDE.md "Injection sites".
export type SessionWireBody = CreateSessionOptions & SessionRequestIdentity & {
  // The managed MCP server set to reconcile into `projects[<cwd>]`, or `null`
  // for a trust-only seed. Absent for non-Claude spawns.
  managedMcpServers?: Record<string, ClaudeMcpServerConfig> | null;
  // Whether to set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` on the pty. Resolved here
  // from `UserSettings.disableClaudeMemory`. Absent for non-Claude spawns.
  disableClaudeMemory?: boolean;
  // The backend-resolved Codex MCP `-c` override strings (inline TOML, one per
  // enabled server). The terminal-server turns each into a `--config` arg with
  // shell-correct env-var referencing. Absent for non-Codex spawns / no servers.
  managedCodexConfigArgs?: string[];
  // Secret env values the child pty must carry for its managed MCP servers
  // (Codex `env_vars` / `env_http_headers` reference these by NAME; the value
  // never enters argv or config). Merged into the pty env in the terminal-server
  // (launchContext), never into the backend's own process env. Absent when there
  // are no secret-bearing managed servers. Despite the name, also the channel
  // for a task-worktree pty's `GIT_LFS_SKIP_SMUDGE=1` (see resolveHarnessSpawnBody)
  // — an existing field, so an older executor applies it too.
  managedMcpEnv?: Record<string, string>;
  // Per-project harness system-prompt override, resolved here and applied by the
  // terminal-server's launch context. Claude: absolute scratch-file paths for
  // `--system-prompt-file` (replace) / `--append-system-prompt-file` (append).
  // Codex: `developer_instructions` / `model_instructions_file` `-c` overrides.
  // Absent for the wrong harness or when nothing is configured. (Pi's override is
  // cwd-local files the backend wrote at resolve time, so it rides no wire field.)
  claudeSystemPromptReplaceFile?: string;
  claudeSystemPromptAppendFile?: string;
  codexSystemPromptConfigArgs?: string[];
};

function isClaudeCommand(initialCommand: string | undefined): boolean {
  return /^\s*claude\b/.test(initialCommand ?? '');
}

function isCodexCommand(initialCommand: string | undefined): boolean {
  return /^\s*codex(?:\.(?:exe|cmd|ps1))?\b/i.test(initialCommand ?? '');
}

function isPiCommand(initialCommand: string | undefined): boolean {
  // `\b` after `pi` keeps `pip`/`pixi`/`ping` from matching (no boundary between
  // `i` and the next word char); matches `pi`, `pi --model …`, `pi.cmd`, …
  return /^\s*pi(?:\.(?:exe|cmd|ps1))?\b/i.test(initialCommand ?? '');
}

// Resolve the per-spawn agent config in the always-fresh main backend and fold
// it into the wire body — the terminal-server only APPLIES the result (it never
// resolves policy). Best-effort throughout: a resolve failure degrades to a
// plain spawn. Runs per harness:
//   - claude → managed MCP server set (+ memory opt-out) + system-prompt files,
//              shipped as wire data.
//   - codex  → `-c` inline-TOML MCP + system-prompt overrides (+ secret env).
//   - pi     → write `<cwd>/.pi/mcp.json` + extension shims here (Pi's mechanism
//              is cwd-local files, not wire data), incl. the system-prompt
//              extension; only the secret env rides the wire. See piMcp.ts.
// Plain shells pass through untouched.
//
// A task-worktree spawn (`opts.mcpScope`) may be narrowed to the Lattice MCP
// server alone — `latticeOnlyMcpApplies` decides, from the project settings
// read ONCE here and handed to every resolver below.
export async function resolveHarnessSpawnBody(
  opts: CreateSessionOptions,
): Promise<SessionWireBody> {
  opts = { ...opts, initialCommand: withCodexActivityTitle(opts.initialCommand) };
  // (Re)generate the project's `.lattice/LATTICE_API*.md` before the pty
  // exists: the terminal-server only looks the doc up for its banner, and the
  // generator lives here in the always-fresh backend so API-doc edits never
  // mark the detached executor stale (see latticeApiDocs/docPath.ts).
  refreshLatticeApiDocs(opts.projectPath?.trim() || opts.cwd);
  if (!opts.cwd) return opts;
  const settings: UserSettings = opts.projectPath
    ? await getUserSettings(opts.projectPath).catch(() => ({}))
    : {};
  const body = await resolveHarnessConfig(opts, settings);
  // A task-worktree pty in the default LFS pointer mode gets
  // GIT_LFS_SKIP_SMUDGE=1, so the agent's own checkouts/merges/resets keep LFS
  // files as pointer stubs (worktree/lfsMode.ts). Any harness, plain spawn or
  // not. Rides the existing `managedMcpEnv` field — the terminal-server merges
  // it into THIS pty's env whatever the harness — so an executor predating this
  // change still applies it.
  const lfsEnv = isTaskWorktreeSpawn(opts)
    ? lfsCheckoutEnv(taskWorktreeLfsContentIn(settings))
    : undefined;
  // Every agent session (not a plain shell) runs its git with auto-gc off, the
  // same as Lattice's own git (worktree/gitAutoGc.ts): an agent's commit would
  // otherwise start a full repack in the shared object store while merges and
  // other agents hold the packs open.
  const gcEnv = isAgentCommand(opts.initialCommand) ? gitConfigEnv(NO_AUTO_GC) : undefined;
  const extraEnv = lfsEnv || gcEnv ? { ...gcEnv, ...lfsEnv } : undefined;
  return extraEnv ? { ...body, managedMcpEnv: { ...(body.managedMcpEnv ?? {}), ...extraEnv } } : body;
}

function isAgentCommand(initialCommand: string | undefined): boolean {
  return isClaudeCommand(initialCommand) || isCodexCommand(initialCommand) || isPiCommand(initialCommand);
}

// What `resolveHarnessConfig` precomputes once and hands every per-harness
// resolver below.
type SpawnContext = {
  latticeOnly: boolean;
  mcpCtx: McpResolveContext;
  promptExtra: string | undefined;
};

async function resolveHarnessConfig(
  opts: CreateSessionOptions & { cwd?: string },
  settings: UserSettings,
): Promise<SessionWireBody> {
  if (!opts.cwd) return opts;
  const latticeOnly = latticeOnlyMcpApplies(opts, settings);
  const mcpCtx = { taskId: opts.taskId, ...(latticeOnly ? { latticeOnly: true } : {}) };
  // A task-worktree agent's "don't run tests" rule rides its system prompt as
  // well as its brief — see taskVerification.ts.
  const promptExtra = isTaskWorktreeSpawn(opts)
    ? renderVerificationSystemPrompt(taskAgentTypecheckIn(settings))
    : undefined;
  const ctx: SpawnContext = { latticeOnly, mcpCtx, promptExtra };
  const cwdOpts = { ...opts, cwd: opts.cwd };
  if (isClaudeCommand(opts.initialCommand)) {
    return resolveClaudeSpawn(cwdOpts, settings, ctx);
  }
  if (isCodexCommand(opts.initialCommand) && opts.projectPath) {
    return resolveCodexSpawn({ ...cwdOpts, projectPath: opts.projectPath }, settings, ctx);
  }
  if (isPiCommand(opts.initialCommand) && opts.projectPath) {
    return resolvePiSpawn({ ...cwdOpts, projectPath: opts.projectPath }, settings, ctx);
  }
  return opts;
}

async function resolveClaudeSpawn(
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

async function resolveCodexSpawn(
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

async function resolvePiSpawn(
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
