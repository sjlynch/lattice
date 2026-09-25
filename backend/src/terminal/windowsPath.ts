import os from 'node:os';
import { execFile } from 'node:child_process';

const isWindows = os.platform() === 'win32';

// On Windows, replace the inherited PATH with one read from the registry
// (HKLM + HKCU `Environment\Path`), merged with any runtime-only entries
// already in `process.env.PATH`. The terminal-server is detached and
// long-lived, so without this its ptys keep inheriting the PATH that was
// current when it was first spawned — a tool installed afterwards
// (winget, MSI installers, ...) is invisible until the terminal-server
// is killed.
//
// The lookup runs OFF the spawn path: a single in-flight async refresh
// updates the cached registry PATH, and `pty.spawn` only ever consumes the
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

// Encapsulate the registry-PATH cache + refresh behind a closure so the
// cache state (last value, last-read timestamp, in-flight read) is not a
// set of loose module globals.
const windowsPathCache = createWindowsPathCache();

function createWindowsPathCache() {
  let cachedRegistryPath: string | null = null;
  let cachedRegistryPathAt = 0;
  let registryReadInFlight: Promise<void> | null = null;

  function maybeRefresh(): void {
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

  return {
    // Kick off a background refresh if stale, and return the currently
    // cached registry PATH (or null if nothing has been read yet).
    current(): string | null {
      maybeRefresh();
      return cachedRegistryPath;
    },
  };
}

export function applyFreshWindowsPath(env: { [key: string]: string }): void {
  if (!isWindows) return;
  const registryPath = windowsPathCache.current();
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

// `LATTICE_PTY_PATH_PREPEND` — directories (platform path-list syntax) that go
// FIRST on every Lattice terminal's PATH, ahead of the registry PATH above.
// Operator escape hatch for wrapping a harness CLI (a `claude` shim that sets
// extra env, a pinned build), and what the self-hosting soak uses to put its
// fake `claude` in front of the real one: after the first spawn the registry
// PATH wins over anything merely inherited, so an inherited prepend alone
// only reaches the very first terminal. Env-based because the detached
// terminal-server reads no settings files. Unset = no change.
export function applyPtyPathPrepend(
  env: { [key: string]: string },
  delimiter = isWindows ? ';' : ':',
): void {
  const prepend = env.LATTICE_PTY_PATH_PREPEND?.split(delimiter).filter(Boolean) ?? [];
  if (prepend.length === 0) return;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const fold = (p: string) => (isWindows ? p.toLowerCase() : p);
  const first = new Set(prepend.map(fold));
  const rest = (env[key] ?? '').split(delimiter).filter((p) => p && !first.has(fold(p)));
  env[key] = [...prepend, ...rest].join(delimiter);
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
