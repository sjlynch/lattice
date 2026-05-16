import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ensureLatticeApiDoc } from '../latticeApiDocs.js';
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
  const latticeEnv: Record<string, string> = {
    LATTICE_API_URL: `http://127.0.0.1:${apiPort}`,
    LATTICE_PROJECT: projectPath,
  };
  const docPath = ensureLatticeApiDoc(projectPath, apiPort);
  if (docPath) latticeEnv.LATTICE_DOCS = docPath;

  const baseEnv: { [key: string]: string } = {
    ...(process.env as { [key: string]: string }),
  };
  applyFreshWindowsPath(baseEnv);

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

// On Windows, replace the inherited PATH with one read live from the
// registry (HKLM + HKCU `Environment\Path`), merged with any runtime-only
// entries already in `process.env.PATH`. The terminal-server is detached
// and long-lived, so without this its ptys keep inheriting the PATH that
// was current when it was first spawned — a tool installed afterwards
// (winget, MSI installers, ...) is invisible until the terminal-server
// is killed. Refreshing per spawn (rather than at module load) means a
// freshly-installed tool shows up in the *next* terminal the user opens.
function applyFreshWindowsPath(env: { [key: string]: string }): void {
  if (!isWindows) return;
  const registryPath = readWindowsRegistryPath();
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

function readWindowsRegistryPath(): string | null {
  try {
    const machine = queryRegPath(
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    );
    const user = queryRegPath('HKCU\\Environment');
    const combined = [machine, user].filter(Boolean).join(';');
    return combined || null;
  } catch {
    return null;
  }
}

function queryRegPath(key: string): string {
  let output: string;
  try {
    output = execFileSync('reg.exe', ['query', key, '/v', 'Path'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    return '';
  }
  // reg.exe output:
  //   HKEY_...
  //       Path    REG_EXPAND_SZ    C:\...;...
  const match = output.match(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
  if (!match) return '';
  return expandEnvRefs(match[1]);
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
