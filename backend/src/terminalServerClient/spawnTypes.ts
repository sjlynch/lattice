import type { ClaudeMcpServerConfig } from '../mcp/claudeInject.js';
import type { McpResolveContext } from '../mcp/registry.js';
import type { McpSpawnScope } from '../mcp/taskWorktreeScope.js';
import type { SessionRequestIdentity } from '../terminalProtocol.js';
import type { TerminalRegistryHint } from '../terminalRegistry/types.js';

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

// What `resolveHarnessConfig` precomputes once and hands every per-harness
// resolver.
export type SpawnContext = {
  latticeOnly: boolean;
  mcpCtx: McpResolveContext;
  promptExtra: string | undefined;
};
