// Optional ripgrep fast-path for the file-contents search (search.ts). When an
// `rg` binary is available it does the tree walk + match in optimized native
// code (10-50x the JS path on large repos); otherwise search.ts falls back to
// reading files in Node. rg is detected once and memoized.
//
// Force-disable with LATTICE_DISABLE_RG=1; point at a specific binary with
// LATTICE_RG_PATH=/path/to/rg (both read here).

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { IGNORE_DIR_NAMES, SOURCE_EXTS } from './health/constants.js';

// Candidate locations probed in order: explicit override, PATH, then the
// common per-user install dirs (cargo/scoop/winget/choco on Windows; the usual
// bin dirs + cargo elsewhere) so detection still works if PATH wasn't refreshed
// for the backend's process.
function candidatePaths(): string[] {
  const cands: string[] = [];
  const override = process.env.LATTICE_RG_PATH;
  if (override) cands.push(override);
  cands.push('rg');
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    const programData = process.env.ProgramData || 'C:\\ProgramData';
    cands.push(path.join(home, '.cargo', 'bin', 'rg.exe'));
    cands.push(path.join(home, 'scoop', 'shims', 'rg.exe'));
    if (local) {
      cands.push(path.join(local, 'Microsoft', 'WinGet', 'Links', 'rg.exe'));
    }
    cands.push(path.join(programData, 'chocolatey', 'bin', 'rg.exe'));
  } else {
    cands.push(
      '/usr/local/bin/rg',
      '/usr/bin/rg',
      '/opt/homebrew/bin/rg',
      path.join(home, '.cargo', 'bin', 'rg'),
    );
  }
  return cands;
}

function probe(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      proc.on('error', () => resolve(false));
      proc.on('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

let cached: Promise<string | null> | null = null;

// Resolves to the rg command to use, or null if none is available. Memoized —
// a backend restart re-detects (so installing rg then restarting picks it up).
export function resolveRipgrep(): Promise<string | null> {
  if (process.env.LATTICE_DISABLE_RG === '1') return Promise.resolve(null);
  if (cached) return cached;
  cached = (async () => {
    for (const c of candidatePaths()) {
      if (await probe(c)) return c;
    }
    return null;
  })();
  return cached;
}

export type RipgrepSearchParams = {
  // A regex *source string* (wildcard queries are pre-translated by the caller),
  // matched case-insensitively. Passed to rg via -e.
  regexSource: string;
  limit: number;
  maxFileBytes: number;
  isCancelled?: () => boolean;
};

export type RipgrepSearchResult = { matches: string[]; truncated: boolean };

// Run rg over `root`, returning absolute paths of files whose contents match.
// Rejects on an rg error (exit 2) — e.g. a pattern rg's regex engine can't
// compile — so the caller can fall back to the JS path for that query.
export function searchWithRipgrep(
  rgCmd: string,
  root: string,
  params: RipgrepSearchParams,
): Promise<RipgrepSearchResult> {
  return new Promise((resolve, reject) => {
    // Restrict to the same file set the scanner uses: only SOURCE_EXTS, minus
    // the always-ignored dirs, honoring .gitignore (rg's default). `--hidden`
    // matches the scanner including dotfiles; .git etc. are excluded below.
    const exts = Array.from(SOURCE_EXTS)
      .map((e) => e.replace(/^\./, ''))
      .join(',');
    const args = [
      '--no-config',
      '--no-messages',
      '--files-with-matches',
      '--null',
      '--ignore-case',
      '--hidden',
      '--max-filesize',
      String(params.maxFileBytes),
      '--glob',
      `*.{${exts}}`,
    ];
    for (const dir of IGNORE_DIR_NAMES) args.push('--glob', `!${dir}`);
    args.push('--regexp', params.regexSource, '--', root);

    const proc = spawn(rgCmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    let stderr = '';
    let killed = false;

    const cancelTimer = setInterval(() => {
      if (params.isCancelled?.() && !killed) {
        killed = true;
        proc.kill();
      }
    }, 100);

    proc.stdout.on('data', (d: Buffer) => out.push(d));
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      clearInterval(cancelTimer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearInterval(cancelTimer);
      if (killed) {
        resolve({ matches: [], truncated: false });
        return;
      }
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2) {
        reject(new Error(stderr.trim() || 'ripgrep error'));
        return;
      }
      const all = Buffer.concat(out)
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((rel) => path.resolve(root, rel));
      resolve({
        matches: all.slice(0, params.limit),
        truncated: all.length > params.limit,
      });
    });
  });
}
