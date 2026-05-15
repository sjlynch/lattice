// Pre-seed Claude Code's "trust this folder" dialog for fresh Lattice-created
// directories. Without this, every new push-scratch and home-scoped worktree
// dir prompts the user on first spawn, because trust is per-project-root and
// those dirs are brand new each time.
//
// `--dangerously-skip-permissions` does NOT cover this — the trust gate runs
// before any settings load and has no documented CLI/env/settings.json knob
// (anthropics/claude-code#28506, #29285). Trust state is persisted in
// `~/.claude.json` under `projects.<forward-slash-abs-path>.hasTrustDialogAccepted`,
// which Claude writes itself on accept; pre-writing it skips the prompt.
// We depend on an undocumented internal key — if Anthropic renames it the
// dialog will come back (not destructive, just annoying).
//
// Read-mutate-write is serialized through a mkdir-based mutex because Claude
// itself rewrites this file on shutdown (lastCost, lastSessionId, etc.) and
// we'd otherwise lost-update each other.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const CLAUDE_GLOBAL_CONFIG = path.join(os.homedir(), '.claude.json');
const LOCK_DIR = path.join(os.homedir(), '.claude.json.lattice-lock');
const LOCK_RETRY_DELAYS_MS = [10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

type ClaudeProjectEntry = {
  hasTrustDialogAccepted?: boolean;
  allowedTools?: unknown[];
  mcpContextUris?: unknown[];
  mcpServers?: Record<string, unknown>;
  enabledMcpjsonServers?: unknown[];
  disabledMcpjsonServers?: unknown[];
  [k: string]: unknown;
};

type ClaudeGlobalConfig = {
  projects?: Record<string, ClaudeProjectEntry>;
  [k: string]: unknown;
};

export async function ensureTrustedClaudeDir(dirPath: string): Promise<void> {
  const key = toClaudeProjectKey(dirPath);
  try {
    await withClaudeConfigLock(async () => {
      const cfg = await readClaudeConfig();
      const projects = (cfg.projects ??= {});
      const existing = projects[key];
      if (existing && existing.hasTrustDialogAccepted === true) return;
      // Mirror the structural empty-collection fields Claude writes on first
      // accept so any later code that introspects the entry doesn't trip on
      // missing fields. Spread `existing` last so we never clobber data Claude
      // wrote (e.g. lastCost on a re-seed of an already-known path).
      projects[key] = {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        ...existing,
        hasTrustDialogAccepted: true,
      };
      await writeClaudeConfigAtomic(cfg);
    });
  } catch (err) {
    console.warn(
      `[claudeTrust] could not pre-seed trust for ${dirPath}: ${(err as Error).message}. ` +
        `Claude may show the trust dialog on first launch.`,
    );
  }
}

// Claude stores project keys with forward slashes even on Windows
// (e.g. "C:/development/lattice"), so normalize before lookup/write.
function toClaudeProjectKey(dirPath: string): string {
  return path.resolve(dirPath).replace(/\\/g, '/');
}

async function readClaudeConfig(): Promise<ClaudeGlobalConfig> {
  try {
    const raw = await fs.readFile(CLAUDE_GLOBAL_CONFIG, 'utf8');
    return JSON.parse(raw) as ClaudeGlobalConfig;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}

async function writeClaudeConfigAtomic(cfg: ClaudeGlobalConfig): Promise<void> {
  const tmp = `${CLAUDE_GLOBAL_CONFIG}.lattice-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  await fs.rename(tmp, CLAUDE_GLOBAL_CONFIG);
}

async function withClaudeConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  for (const delay of [0, ...LOCK_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    try {
      await fs.mkdir(LOCK_DIR);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      continue;
    }
    try {
      return await fn();
    } finally {
      await fs.rmdir(LOCK_DIR).catch(() => {});
    }
  }
  // Lock never acquired (likely stale from a crashed writer). Steal and
  // proceed — trust pre-seed is best-effort and a lost-update here just
  // means the dialog might appear once.
  await fs.rmdir(LOCK_DIR).catch(() => {});
  await fs.mkdir(LOCK_DIR).catch(() => {});
  try {
    return await fn();
  } finally {
    await fs.rmdir(LOCK_DIR).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
