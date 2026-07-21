import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { precreateSession } from '../terminal.js';
import { applyClaudeProjectConfig } from '../claudeTrust.js';
import type { ClaudeMcpServerConfig } from '../mcp/claudeInject.js';

export type TerminalSessionRequestBody = {
  cwd?: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  projectPath?: string;
  // Pre-resolved by the BACKEND (terminalServerClient.resolveHarnessSpawnBody)
  // and applied verbatim here — the terminal-server resolves no policy.
  // `managedMcpServers` is the CLAUDE server set to reconcile into
  // `projects[<cwd>]` (or `null` for a trust-only seed); `disableClaudeMemory`
  // is the resolved auto-memory opt-out for the pty env.
  managedMcpServers?: Record<string, ClaudeMcpServerConfig> | null;
  disableClaudeMemory?: boolean;
  // CODEX MCP: the backend-resolved inline-TOML `-c` override strings (one per
  // enabled server). Turned into `--config` args by the pty launch context
  // (configureCodexProjectMcp). `managedMcpEnv` carries the secret env values
  // those overrides reference by name — merged into the child pty env only.
  managedCodexConfigArgs?: string[];
  managedMcpEnv?: Record<string, string>;
  // Per-project harness system-prompt override (backend-resolved). Claude: the
  // scratch-file paths for --system-prompt-file / --append-system-prompt-file.
  // Codex: the developer_instructions / model_instructions_file `-c` overrides.
  // Applied by the pty launch context; no-op for the wrong harness / when absent.
  claudeSystemPromptReplaceFile?: string;
  claudeSystemPromptAppendFile?: string;
  codexSystemPromptConfigArgs?: string[];
};

export type CreateSessionHandlerDeps = {
  applyClaudeProjectConfig?: typeof applyClaudeProjectConfig;
  precreateSession?: typeof precreateSession;
};

/**
 * Pre-create a pty session without a WS subscriber. Route handlers in the main
 * backend call this so they can return a serverId synchronously; the frontend
 * then lazy-mounts <TerminalPane> and attaches via that id.
 *
 * `async` so it can re-seed Claude trust before spawning — but Express 4 does
 * NOT forward an async rejection to the error middleware, so the body is
 * wrapped and any throw is handed to `next` explicitly (preserving the
 * JSON-only error surface routes.ts guarantees).
 */
export function createSessionHandler(
  deps: CreateSessionHandlerDeps = {},
): RequestHandler {
  const applyConfig = deps.applyClaudeProjectConfig ?? applyClaudeProjectConfig;
  const create = deps.precreateSession ?? precreateSession;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = (req.body || {}) as TerminalSessionRequestBody;
      // APPLY the backend-resolved Claude project config for `cwd` here,
      // microseconds before pty.spawn. The spawn sites already pre-seed trust at
      // session-setup time, but a queued spawn can sit in the admission queue for
      // minutes before reaching here — and during that gap any *other* Claude
      // process exiting rewrites the whole `~/.claude.json` from its own stale
      // in-memory snapshot, silently dropping the entry we added (Claude never
      // takes Lattice's mutex). Applying again at this chokepoint shrinks the
      // clobber window to near zero so an agent never stalls on the "Do you
      // trust the files in this folder?" dialog and always gets the right MCP
      // servers.
      //
      // This stays the timing-critical WRITE point, but it is no longer where
      // policy is *decided*: the backend computed `managedMcpServers` (which
      // servers, headed/headless) and `disableClaudeMemory` and shipped them in
      // the body. Keeping resolution out of this long-lived detached process is
      // what lets a spawn-policy change be a backend-only edit (no respawn,
      // never stale). Best-effort + Claude-only: `applyClaudeProjectConfig`
      // swallows its own errors, and applying Claude's config format for
      // pi/codex would just churn an unrelated file. Codex trust is handled
      // separately by the PTY launch context as a process-local `--config`
      // override.
      const isClaudeCmd = /^\s*claude\b/.test(body.initialCommand ?? '');
      if (body.cwd && isClaudeCmd) {
        await applyConfig(body.cwd, {
          managed: body.managedMcpServers ?? null,
        });
      }
      const result = create({
        cwd: body.cwd,
        cols: body.cols,
        rows: body.rows,
        initialCommand: body.initialCommand,
        projectPath: body.projectPath,
        disableClaudeMemory: body.disableClaudeMemory ?? false,
        // Codex MCP: applied by the launch context (config args → `--config`
        // flags, secret env → child pty env). No-ops for non-Codex spawns.
        managedCodexConfigArgs: body.managedCodexConfigArgs,
        managedMcpEnv: body.managedMcpEnv,
        // Harness system-prompt override: applied by the launch context per
        // harness (Claude flags / Codex `-c`). No-ops when absent.
        claudeSystemPromptReplaceFile: body.claudeSystemPromptReplaceFile,
        claudeSystemPromptAppendFile: body.claudeSystemPromptAppendFile,
        codexSystemPromptConfigArgs: body.codexSystemPromptConfigArgs,
      });
      if ('error' in result) {
        // A hard-cap refusal is 503 ("at capacity") so the backend proxy can
        // distinguish it from a 500 shell-spawn failure; the `code` field is the
        // authoritative signal either way.
        return res.status(result.code === 'CAP' ? 503 : 500).json(result);
      }
      res.json({ id: result.id });
    } catch (err) {
      next(err);
    }
  };
}
