// Which `opengrep` to run. A copy the user installed themselves (on PATH)
// always wins over the Lattice-managed one, so a package-manager install is
// never overridden; the managed binary is the fallback. Memoized like
// harnessDetect.ts (`resetOpengrepCache()` after an install), and probed by
// actually running `--version`, which is also the antivirus-quarantine check:
// a binary that was installed but has since been removed shows up as ENOENT
// here rather than as a confusing failure mid-scan.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { managedBinaryPath } from './paths.js';
import { OPENGREP_VERSION } from './versions.js';

export type OpengrepSource = 'path' | 'managed';

export type OpengrepResolution = {
  // Absolute path (or the bare name for a PATH hit that `where`/`which` could
  // not resolve to a file) to spawn with `shell: false`.
  command: string;
  source: OpengrepSource;
  version: string;
};

// `--version` on a cold cache can take a few seconds (the binary is a
// self-contained ~50 MB executable).
const VERSION_PROBE_TIMEOUT_MS = 30_000;
const PATH_PROBE_TIMEOUT_MS = 3_000;

let cached: Promise<OpengrepResolution | null> | null = null;

// The first `where`/`which` hit, or null. Returns the resolved absolute file so
// the scan can spawn it without a shell (rule paths and exclude globs are
// user-configured strings — they must never pass through `cmd.exe`).
export async function findOnPath(cmd = 'opengrep'): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    let out = '';
    let settled = false;
    const finish = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn(probe, [cmd], { shell: false, windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child!.kill();
      } catch {
        /* exited */
      }
      finish(null);
    }, PATH_PROBE_TIMEOUT_MS);
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const first = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      finish(code === 0 && first ? first : null);
    });
  });
}

// Runs `<command> --version` and returns the `x.y.z` it prints, or null when
// the binary is missing / not runnable / prints nothing recognisable.
export async function probeOpengrepVersion(command: string): Promise<string | null> {
  const r = await spawnWithTimeout(command, ['--version'], {
    timeoutMs: VERSION_PROBE_TIMEOUT_MS,
  });
  if (r.error || r.timedOut || r.code !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.combined);
  return m ? m[1] : null;
}

async function resolveUncached(): Promise<OpengrepResolution | null> {
  const onPath = await findOnPath();
  if (onPath) {
    const version = await probeOpengrepVersion(onPath);
    if (version) return { command: onPath, source: 'path', version };
  }
  const managed = managedBinaryPath(OPENGREP_VERSION);
  try {
    await fs.access(managed);
  } catch {
    return null;
  }
  const version = await probeOpengrepVersion(managed);
  if (!version) return null;
  return { command: managed, source: 'managed', version };
}

export function resolveOpengrep(): Promise<OpengrepResolution | null> {
  if (!cached) {
    const probe = resolveUncached().catch((err) => {
      console.warn('[opengrep] resolve failed:', err);
      return null;
    });
    cached = probe;
    // A miss is not cached for long: the user may install it (or install the
    // managed one) and expect the next status call to see it. Only clear the
    // slot if it still holds THIS probe — an install that reset the cache and
    // started a fresh probe in the meantime must not have it thrown away.
    void probe.then((r) => {
      if (!r && cached === probe) cached = null;
    });
  }
  return cached;
}

export function resetOpengrepCache(): void {
  cached = null;
}
