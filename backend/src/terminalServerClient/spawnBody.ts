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
  isTaskWorktreeSpawn,
  latticeOnlyMcpApplies,
} from '../mcp/taskWorktreeScope.js';
import { withCodexActivityTitle } from '../codexTerminalActivity.js';
import { refreshLatticeApiDocs } from '../latticeApiDocs.js';
import { resolveClaudeSpawn } from './spawnClaude.js';
import { resolveCodexSpawn } from './spawnCodex.js';
import { resolvePiSpawn } from './spawnPi.js';
import type { CreateSessionOptions, SessionWireBody, SpawnContext } from './spawnTypes.js';

export type { CreateSessionOptions, SessionWireBody } from './spawnTypes.js';

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
// read ONCE here and handed to every resolver.
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
