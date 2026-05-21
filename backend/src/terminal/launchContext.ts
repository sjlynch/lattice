import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
import { canonicalProjectPath, projectHash } from '../projectPath.js';
import type { CreateOpts } from './sessionTypes.js';

const isWindows = os.platform() === 'win32';
const defaultShell = isWindows
  ? process.env.COMSPEC || 'powershell.exe'
  : process.env.SHELL || 'bash';

export type SessionLaunchContext = {
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  projectPath: string;
  env: { [key: string]: string };
  docPath: string | null;
};

export function buildSessionLaunchContext(
  opts: CreateOpts,
): SessionLaunchContext | { error: string } {
  const shell = opts.shell || defaultShell;
  const requestedCwd = opts.cwd?.trim();
  const cwd = requestedCwd || os.homedir();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const projectPath = opts.projectPath?.trim() || cwd;

  const cwdError = validateRequestedCwd(requestedCwd);
  if (cwdError) return cwdError;

  // Plant breadcrumbs so AI agents running inside this pty can discover the
  // Lattice API without any user-side config. The vars only exist in this
  // child process; the user's shell env is untouched.
  const apiPort = Number(process.env.LATTICE_API_PORT) || 5184;
  const canonicalProject = canonicalProjectPath(projectPath);
  const latticeEnv: Record<string, string> = {
    LATTICE_API_URL: `http://127.0.0.1:${apiPort}`,
    LATTICE_PROJECT: canonicalProject,
    LATTICE_PROJECT_HASH: projectHash(canonicalProject),
  };
  const docPath = ensureLatticeApiDoc(projectPath, apiPort);
  if (docPath) latticeEnv.LATTICE_DOCS = docPath;

  const baseEnv: { [key: string]: string } = {
    ...(process.env as { [key: string]: string }),
  };
  applyFreshWindowsPath(baseEnv);
  applyClaudeOverheadEnv(baseEnv);

  return {
    shell,
    cwd,
    cols,
    rows,
    projectPath,
    env: { ...baseEnv, ...latticeEnv },
    docPath,
  };
}

// On Windows, replace the inherited PATH with one read from the registry
// (HKLM + HKCU `Environment\Path`), merged with any runtime-only entries
// already in `process.env.PATH`. The terminal-server is detached and
// long-lived, so without this its ptys keep inheriting the PATH that was
// current when it was first spawned — a tool installed afterwards
// (winget, MSI installers, ...) is invisible until the terminal-server
// is killed.
//
// The lookup runs OFF the spawn path: a single in-flight async refresh
// updates `cachedRegistryPath`, and `pty.spawn` only ever consumes the
// cached string. `execFileSync('reg.exe', ...)` blocked the
// terminal-server's event loop for the duration of two subprocess calls
// on every WS attach — under "Run All" or just a slow reg.exe (AV
// scanning, registry pressure) that produced "completely empty" terminal
// panes because the upgrade handler couldn't even finish wiring the pty.
// First spawn after boot uses the inherited PATH; the next spawn after
// the background read completes (typically <200 ms later) picks up the
// fresh registry value. A 30 s TTL keeps newly-installed tools visible
// within half a minute without paying the cost on every spawn.
const REGISTRY_PATH_TTL_MS = 30_000;
const REGISTRY_QUERY_TIMEOUT_MS = 5_000;
let cachedRegistryPath: string | null = null;
let cachedRegistryPathAt = 0;
let registryReadInFlight: Promise<void> | null = null;

function applyFreshWindowsPath(env: { [key: string]: string }): void {
  if (!isWindows) return;
  maybeRefreshRegistryPath();
  const registryPath = cachedRegistryPath;
  if (!registryPath) return;

  // Node on Windows exposes PATH under whatever case the OS gave it
  // (typically `Path`). Spreading process.env preserves that key; if we
  // then set `env.PATH = ...` we'd end up with BOTH `Path` and `PATH`
  // and node-pty / Windows would pick one unpredictably. Strip every
  // case variant before writing back a single canonical `Path`.
  const inherited = env.PATH ?? env.Path ?? '';
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === 'path') delete env[k];
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (registryPath + ';' + inherited).split(';')) {
    if (!part) continue;
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  env.Path = out.join(';');
}

// Claude Code does several pieces of background work on every launch that are
// pure overhead for an orchestrated agent: an autoupdater check (which can
// spawn an updater child process), telemetry + error-reporting uploads, and
// non-essential background model calls (conversation titling and similar).
// Under "Run All" / workflow fan-out there can be dozens of Claude processes
// alive at once, so that per-process overhead multiplies and competes for
// CPU + network with the work the user actually queued. Disable it for every
// pty Lattice spawns. Applied as defaults only — a value already present in
// the environment (the user opting in or out themselves) is left untouched.
const CLAUDE_OVERHEAD_ENV: Record<string, string> = {
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
};

function applyClaudeOverheadEnv(env: { [key: string]: string }): void {
  for (const [key, value] of Object.entries(CLAUDE_OVERHEAD_ENV)) {
    if (!env[key]) env[key] = value;
  }
}

function maybeRefreshRegistryPath(): void {
  if (registryReadInFlight) return;
  const age = Date.now() - cachedRegistryPathAt;
  if (cachedRegistryPath !== null && age < REGISTRY_PATH_TTL_MS) return;

  registryReadInFlight = readWindowsRegistryPathAsync()
    .then((value) => {
      cachedRegistryPath = value;
      cachedRegistryPathAt = Date.now();
    })
    .catch(() => {
      // Keep whatever we had; just back off so we don't hammer reg.exe.
      cachedRegistryPathAt = Date.now();
    })
    .finally(() => {
      registryReadInFlight = null;
    });
}

async function readWindowsRegistryPathAsync(): Promise<string> {
  const [machine, user] = await Promise.all([
    queryRegPathAsync(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    ),
    queryRegPathAsync('HKCU\\Environment'),
  ]);
  return [machine, user].filter(Boolean).join(';');
}

function queryRegPathAsync(key: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', key, '/v', 'Path'],
      { encoding: 'utf8', timeout: REGISTRY_QUERY_TIMEOUT_MS, windowsHide: true },
      (_err, stdout) => {
        if (!stdout) return resolve('');
        const match = stdout.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
        resolve(match ? expandEnvRefs(match[1]) : '');
      },
    );
  });
}

function expandEnvRefs(value: string): string {
  return value.replace(/%([^%]+)%/g, (_, name: string) => {
    const v = process.env[name];
    return v ?? `%${name}%`;
  });
}

function validateRequestedCwd(cwd: string | undefined): { error: string } | null {
  // Refuse to spawn into a non-existent cwd. Without this, pty.spawn
  // succeeds on Windows but the shell exits immediately — and if a
  // client is reconnecting in a loop (e.g. after a worktree was
  // deleted), every cycle spawns a doomed shell. The exit closes the
  // WS, the client reconnects, repeat forever. A simple existence
  // check turns that infinite loop into a one-shot error.
  if (!cwd) return null;
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) {
      return { error: `cwd is not a directory: ${cwd}` };
    }
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }
  return null;
}
