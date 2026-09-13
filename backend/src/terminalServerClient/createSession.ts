import {
  BASE,
  ensureTerminalServer,
  probeTerminalServer,
} from '../terminalServerLifecycle.js';
import {
  resolveManagedClaudeServers,
  resolveManagedCodexServers,
} from '../mcp/registry.js';
import { applyPiMcpForSpawn } from '../piMcp.js';
import {
  prepareClaudeSystemPrompt,
  prepareCodexSystemPrompt,
  preparePiSystemPrompt,
  type ClaudeSystemPromptFiles,
} from '../harnessSystemPrompts.js';
import { isClaudeMemoryDisabled } from '../userSettings.js';
import type { ClaudeMcpServerConfig } from '../mcp/claudeInject.js';
import { terminalServerAuthHeaders } from '../terminalServerAuth.js';
import { randomUUID } from 'node:crypto';
import type { SessionRequestIdentity, TerminalServerInfo } from '../terminalProtocol.js';
import { withCodexActivityTitle } from '../codexTerminalActivity.js';

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
  // Set only by the task run/resume spawns (`routes/tasks/harnessFactory.ts`):
  // the task whose worktree this session is. Used HERE to bake `LATTICE_TASK_ID`
  // into the first-party `lattice` MCP server's env, so the worktree agent gets
  // a `my_task` tool and an `append_summary` that defaults to its own task —
  // without having to read its id back out of LATTICE_TASK.md. Like `isQaRun`,
  // it rides the wire body but the terminal-server never reads it.
  taskId?: string;
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
  // are no secret-bearing managed servers.
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
async function resolveHarnessSpawnBody(
  opts: CreateSessionOptions,
): Promise<SessionWireBody> {
  opts = { ...opts, initialCommand: withCodexActivityTitle(opts.initialCommand) };
  if (!opts.cwd) return opts;
  if (isClaudeCommand(opts.initialCommand)) {
    // No projectPath → trust-only seed (managed: null) + Claude's default memory.
    const managedMcpServers = opts.projectPath
      ? await resolveManagedClaudeServers(opts.projectPath, {
          isQaRun: opts.isQaRun,
          taskId: opts.taskId,
        })
      : null;
    const disableClaudeMemory = opts.projectPath
      ? await isClaudeMemoryDisabled(opts.projectPath).catch(() => false)
      : false;
    const sysPrompt: ClaudeSystemPromptFiles = opts.projectPath
      ? await prepareClaudeSystemPrompt(opts.projectPath).catch(() => ({}))
      : {};
    return {
      ...opts,
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
  if (isCodexCommand(opts.initialCommand) && opts.projectPath) {
    const codex = await resolveManagedCodexServers(opts.projectPath, { taskId: opts.taskId });
    const sysPrompt = await prepareCodexSystemPrompt(opts.projectPath).catch(
      () => ({ configArgs: [] as string[] }),
    );
    const mcpArgs = codex?.configArgs ?? [];
    const env = codex?.env ?? {};
    // Nothing to inject → plain spawn.
    if (mcpArgs.length === 0 && sysPrompt.configArgs.length === 0) return opts;
    return {
      ...opts,
      ...(mcpArgs.length > 0 ? { managedCodexConfigArgs: mcpArgs } : {}),
      ...(sysPrompt.configArgs.length > 0
        ? { codexSystemPromptConfigArgs: sysPrompt.configArgs }
        : {}),
      ...(Object.keys(env).length > 0 ? { managedMcpEnv: env } : {}),
    };
  }
  if (isPiCommand(opts.initialCommand) && opts.projectPath) {
    const env = await applyPiMcpForSpawn(opts.cwd, opts.projectPath, { taskId: opts.taskId });
    // Reconcile the Pi system-prompt extension in the cwd (installs it when
    // there's an override, strips a stale one otherwise). Cwd-local files, so
    // nothing rides the wire — like the MCP shim.
    await preparePiSystemPrompt(opts.cwd, opts.projectPath).catch(() => {});
    if (Object.keys(env).length > 0) return { ...opts, managedMcpEnv: env };
    return opts;
  }
  return opts;
}

// Hard timeout on a single POST /sessions. Generous on purpose: a normal pty
// pre-create is sub-second, but under a heavy "Run All" burst the trust-seed
// file I/O on the shared ~/.claude.json plus the conpty spawn can legitimately
// take a few seconds, so anything under ~30s would risk aborting a spawn that
// was about to succeed. Past that, the request is almost certainly WEDGED (a
// stuck conpty handle or a black-holed socket to :5185), and we must not wait
// on it forever: the spawn queue holds a concurrency reservation for the WHOLE
// spawn thunk and only reclaims it once this call settles, so an un-timed hang
// here permanently leaks a slot and silently lowers the effective agent cap
// below the configured `maxConcurrentAgents` (the "Run All gave me 15 of 24"
// symptom). Bounding the call guarantees the thunk always settles and the slot
// is always returned to the queue.
const CREATE_SESSION_TIMEOUT_MS = 30_000;

// `code: 'CAP'` ⇒ the failure was the terminal-server's hard session cap.
// The spawn queue keys its over-admit back-off on this; any other failure
// is a genuine error.
export type CreateSessionResult =
  | { id: string }
  | { error: string; code?: 'CAP' };

type CreateOnce =
  | { id: string }
  | { error: string; recoverable: boolean; code?: 'CAP' };

// Pre-create a pty session in the terminal-server subprocess. Returns the
// session id so route handlers can include it in their response and the
// frontend can attach via that id later (instead of triggering creation by
// opening a WS).
//
// Retry only when the same executor advertises request deduplication. A lost
// response can mean the PTY already exists; replaying into a legacy/replacement
// server could start the agent twice. A broken request never tears down peers.
export async function proxyCreateSession(
  opts: CreateSessionOptions,
): Promise<CreateSessionResult> {
  let server: TerminalServerInfo;
  try { server = await ensureTerminalServer(); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  const canRetry = server.capabilities?.idempotentCreate === true && !!server.instanceId;
  const body: SessionWireBody = {
    ...await resolveHarnessSpawnBody(opts),
    ...(canRetry ? { requestId: randomUUID(), requestTimestamp: Date.now(), serverInstanceId: server.instanceId } : {}),
  };
  const first = await tryCreateSessionOnce(body);
  if ('id' in first) return first;
  if (!first.recoverable) return { error: first.error, code: first.code };
  const uncertain = `${first.error}. Session creation outcome is unknown; it was not replayed to avoid starting a duplicate agent.`;
  if (!canRetry) return { error: uncertain };
  const current = await probeTerminalServer();
  if (current.kind !== 'ready' || current.info.instanceId !== server.instanceId
      || !current.info.capabilities?.idempotentCreate) return { error: uncertain };
  const retry = await tryCreateSessionOnce(body);
  if ('id' in retry) return retry;
  return { error: retry.recoverable
    ? `${retry.error}. Session creation outcome remains unknown after the bounded retry.`
    : retry.error, code: retry.code };
}

export async function tryCreateSessionOnce(
  body: SessionWireBody,
): Promise<CreateOnce> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...terminalServerAuthHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CREATE_SESSION_TIMEOUT_MS),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return {
      error: name === 'TimeoutError' || name === 'AbortError'
        ? `terminal-server did not respond within ${CREATE_SESSION_TIMEOUT_MS}ms`
        : err instanceof Error ? err.message : String(err),
      // Even a timeout can follow successful allocation. The caller retries
      // only against this same executor with the same deduplicated request ID.
      recoverable: true,
    };
  }
  const text = await res.text().catch(() => '');
  type SessionBody = { id?: string; error?: string; code?: 'CAP' };
  let parsed: SessionBody | null = null;
  try {
    parsed = text ? (JSON.parse(text) as SessionBody) : null;
  } catch {
    // HTML / plain-text body → almost certainly a stale terminal-server
    // (missing route) or a wrong process bound to the port.
    const preview = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    return {
      error: `terminal-server returned non-JSON (status ${res.status}): ${preview}`,
      recoverable: true,
    };
  }
  if (res.ok && (!parsed || typeof parsed.id !== 'string' || !parsed.id)) {
    return { error: `terminal-server returned an invalid session response (status ${res.status})`, recoverable: true };
  }
  if (!res.ok) {
    return {
      error: typeof parsed?.error === 'string' ? parsed.error : `terminal-server ${res.status}`,
      recoverable: false,
      code: parsed?.code === 'CAP' ? 'CAP' : undefined,
    };
  }
  return { id: parsed!.id! };
}
