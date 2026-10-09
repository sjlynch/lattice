// Task-worktree MCP scope: a task agent (run/resume) or a merge-conflict
// resolver in a task's worktree gets ONLY Lattice's own `lattice` MCP server
// (per-project `taskAgentsLatticeMcpOnly`, default ON) — each idle stdio server
// is a ~100–180 MB process tree per agent. Contract: mcp/CLAUDE.md →
// "Task-worktree scope".
//
// Decided at the spawn chokepoint (`terminalServerClient/createSession.ts`
// `resolveHarnessSpawnBody`) from three facts, ALL required:
//   1. `CreateSessionOptions.mcpScope = 'task-worktree'` (task run/resume, the
//      manual + merge-run WORKTREE resolvers; never the stash/snapshot
//      resolvers, which run at the project root);
//   2. the project setting is on;
//   3. the cwd is under `~/.lattice/worktrees/` — a hard guard so the restricted
//      set never lands at a project root, where the Claude reconcile writes the
//      user's own persisted `projects[<root>].mcpServers`.
// Claude also gets `--strict-mcp-config --mcp-config=<file>`, appended in the
// BACKEND (a stale terminal-server executor ignores new wire fields); the file
// is in home scratch so `claude --resume` finds it. Codex's `-c` overrides carry
// only lattice, after `enabled=false` for each server the user's `config.toml`
// files name (`-c mcp_servers={}` removes nothing; disabling an unknown name
// fails startup). Pi restricts only Lattice-managed servers (pi-mcp-adapter
// merges user MCP files with no off switch).

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { homeProjectScratchDir, latticeHomeDir } from '../projectPath.js';
import { isPathStrictlyInside } from '../worktree/paths.js';
import { taskAgentsLatticeMcpOnlyIn, type UserSettings } from '../userSettings.js';
import { parseCodexMcpServers } from './import/codexToml.js';
import type { ClaudeMcpServerConfig } from './claudeInject.js';

export type { McpSpawnScope } from './spawnScope.js';
import type { McpSpawnScope } from './spawnScope.js';

// `~/.lattice/worktrees/` — every current task worktree lives below it
// (`<hash>/<slug>-<id>`). Legacy in-repo worktrees (`<repo>/.lattice/worktrees`)
// are deliberately NOT matched: they sit inside the project tree.
function worktreesRoot(): string {
  return path.join(latticeHomeDir(), 'worktrees');
}

// Whether this spawn gets the lattice-only MCP set. See the header for the
// three conditions.
export function latticeOnlyMcpApplies(
  spawn: { mcpScope?: McpSpawnScope; cwd?: string },
  settings: UserSettings,
): boolean {
  return isTaskWorktreeSpawn(spawn) && taskAgentsLatticeMcpOnlyIn(settings);
}

// A task run/resume or worktree merge-conflict resolver, in a home-scoped task
// worktree — conditions 1 and 3 above, without the MCP setting. Also what
// decides the system-prompt verification rule (`../taskVerification.ts`).
export function isTaskWorktreeSpawn(spawn: { mcpScope?: McpSpawnScope; cwd?: string }): boolean {
  return spawn.mcpScope === 'task-worktree' && !!spawn.cwd && isPathStrictlyInside(worktreesRoot(), spawn.cwd);
}

// ---- Claude ------------------------------------------------------------

const CLAUDE_MCP_CONFIG_DIR = 'mcp-config';
// Config files are rewritten on every spawn, so an old one is never needed;
// this only bounds the directory's growth (one small file per task).
const CLAUDE_MCP_CONFIG_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

// Write the `--mcp-config` file for one scoped Claude spawn and return its
// absolute path. Keyed by task (resolver and agent share one; the content is
// identical for both) or, failing that, by cwd. Atomic write via a unique temp
// + rename, so two concurrent spawns for one task never read a torn file.
export async function writeClaudeStrictMcpConfig(
  projectPath: string,
  key: { taskId?: string; cwd: string },
  servers: Record<string, ClaudeMcpServerConfig>,
): Promise<string> {
  const dir = homeProjectScratchDir(projectPath, CLAUDE_MCP_CONFIG_DIR);
  await fs.mkdir(dir, { recursive: true });
  const safeTask = key.taskId?.replace(/[^A-Za-z0-9_-]/g, '');
  const name = safeTask
    ? `claude-task-${safeTask}.json`
    : `claude-cwd-${crypto.createHash('sha1').update(path.resolve(key.cwd)).digest('hex').slice(0, 12)}.json`;
  const file = path.join(dir, name);
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  // 0600: the lattice entry carries no secret today, but a built-in override's
  // `env` could, and the file sits beside nothing else that needs to read it.
  await fs.writeFile(tmp, JSON.stringify({ mcpServers: servers }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  await fs.rename(tmp, file);
  void pruneOldConfigs(dir);
  return file;
}

async function pruneOldConfigs(dir: string): Promise<void> {
  try {
    const cutoff = Date.now() - CLAUDE_MCP_CONFIG_MAX_AGE_MS;
    for (const name of await fs.readdir(dir)) {
      if (!name.startsWith('claude-')) continue;
      const file = path.join(dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (st?.isFile() && st.mtimeMs < cutoff) await fs.unlink(file).catch(() => {});
    }
  } catch { /* best effort */ }
}

// Characters that would need shell-specific escaping inside a double-quoted
// argument on at least one of cmd / PowerShell / POSIX sh. A home dir with one
// of them can't be quoted portably, so the caller falls back to an unscoped
// spawn rather than risk a broken or injected command line.
const UNPORTABLE_PATH_CHARS = /["%$`!\r\n\0]/;

// `claude … --strict-mcp-config --mcp-config="<file>"`. The `=` form is
// load-bearing: `--mcp-config` is variadic, and a space-separated value would
// let it swallow following args. Forward slashes on Windows (Claude/Node read
// them fine) so no backslash ever meets a shell's escape rules. Returns `null`
// when the command already sets its own MCP flags (a relaunch must not stack
// a second copy) or the path can't be quoted portably.
export function withClaudeStrictMcpFlags(
  command: string,
  configFile: string,
): string | null {
  if (/(?:^|\s)--(?:strict-mcp-config|mcp-config)(?:[\s=]|$)/.test(command)) return null;
  const portable = process.platform === 'win32' ? configFile.replace(/\\/g, '/') : configFile;
  if (UNPORTABLE_PATH_CHARS.test(portable)) return null;
  return `${command} --strict-mcp-config --mcp-config="${portable}"`;
}

// ---- Codex -------------------------------------------------------------

// A Codex server name that can be written as a bare TOML dotted-key segment.
// Anything else is left alone (still enabled) rather than risk a bad override.
const BARE_CODEX_KEY = /^[A-Za-z0-9_-]+$/;

// `-c mcp_servers.<name>.enabled=false` for every MCP server the user's own
// Codex config defines — `$CODEX_HOME/config.toml` (default `~/.codex`) and the
// session cwd's `.codex/config.toml` (Codex reads the project layer for a
// trusted cwd, and Lattice trusts every one it spawns in). `managedKeys` are
// the `lattice_*` keys this spawn defines itself; never disabled. Best-effort:
// an unreadable file contributes nothing. Order-stable (sorted) so a spawn's
// wire body is deterministic.
export async function codexUserServerDisableArgs(
  cwd: string,
  managedKeys: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const codexHome = env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const files = [path.join(codexHome, 'config.toml'), path.join(cwd, '.codex', 'config.toml')];
  const names = new Set<string>();
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;
    for (const name of Object.keys(parseCodexMcpServers(text))) {
      if (BARE_CODEX_KEY.test(name) && !managedKeys.has(name)) names.add(name);
    }
  }
  return [...names].sort().map((name) => `mcp_servers.${name}.enabled=false`);
}
