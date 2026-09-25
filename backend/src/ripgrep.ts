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
import { StringDecoder } from 'node:string_decoder';
import { IGNORE_DIR_NAMES, SOURCE_EXTS } from './health/constants.js';
import { CANCEL_POLL_MS } from './search/constants.js';

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

// Incremental collector for `rg --files-with-matches --null` output. rg emits
// each matching path terminated by a NUL byte; a single stdout chunk can split a
// path — and even a multi-byte UTF-8 code point — across the boundary, so we
// decode with a StringDecoder (which holds back incomplete byte sequences) and
// keep a `carry` string for the partial trailing path between chunks.
//
// The point of parsing incrementally (rather than `Buffer.concat` at close) is
// early termination: we stop as soon as ONE complete path beyond `limit`
// arrives — that single extra path is all we need to know the result is
// truncated — so the caller can kill rg without buffering (and re-parsing) the
// rest of the repo's matches. `matches` never grows past `limit`.
export class RgPathCollector {
  private readonly decoder = new StringDecoder('utf8');
  private carry = '';
  readonly matches: string[] = [];
  truncated = false;
  // Set once we've seen `limit + 1` complete paths: enough to know the result
  // is truncated. The caller treats this as "kill rg and stop reading".
  done = false;

  constructor(
    private readonly root: string,
    private readonly limit: number,
  ) {}

  // Feed one stdout chunk. Returns `true` once enough paths have been collected
  // to determine truncation (the caller should then kill rg and ignore the
  // remaining stream). Idempotent/cheap after `done` — extra chunks are dropped
  // rather than decoded or buffered, keeping memory bounded on a broad query.
  push(chunk: Buffer): boolean {
    if (this.done) return true;
    this.carry += this.decoder.write(chunk);
    return this.drain();
  }

  // Flush after rg closes on its own: decode any bytes still held by the
  // decoder, then count a final path that had no trailing NUL. rg always
  // terminates each path with a NUL, but this stays defensive so the semantics
  // match the old `Buffer.concat(out).split('\0').filter(Boolean)` path exactly.
  end(): void {
    if (this.done) return;
    this.carry += this.decoder.end();
    if (this.drain()) return;
    const tail = this.carry;
    this.carry = '';
    if (tail) this.accept(tail);
  }

  // Consume every complete (NUL-terminated) path currently in `carry`.
  private drain(): boolean {
    let idx: number;
    while (!this.done && (idx = this.carry.indexOf('\0')) !== -1) {
      const rel = this.carry.slice(0, idx);
      this.carry = this.carry.slice(idx + 1);
      if (rel) this.accept(rel);
    }
    return this.done;
  }

  private accept(rel: string): void {
    if (this.matches.length < this.limit) {
      this.matches.push(path.resolve(this.root, rel));
    } else {
      // One complete path beyond the cap ⇒ there are > limit matches. Record
      // truncation, drop the carry, and signal the caller to stop.
      this.truncated = true;
      this.done = true;
      this.carry = '';
    }
  }
}

// rg exit codes: 0 = matches, 1 = no matches, 2 = error.
const RG_EXIT_ERROR = 2;

// The rg argv for one content search over `root` (pure — no spawn).
export function buildRipgrepArgs(
  root: string,
  params: Pick<RipgrepSearchParams, 'regexSource' | 'maxFileBytes'>,
): string[] {
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
    // rg only honors .gitignore INSIDE a git repo by default, but the scanner
    // (scanner/ignore.ts) applies the root .gitignore to any project — so in a
    // not-yet-`git init`ed folder rg searched ignored build output too,
    // returning non-graph paths that ate the match `limit`.
    '--no-require-git',
    '--max-filesize',
    String(params.maxFileBytes),
    '--glob',
    `*.{${exts}}`,
  ];
  for (const dir of IGNORE_DIR_NAMES) args.push('--glob', `!${dir}`);
  args.push('--regexp', params.regexSource, '--', root);
  return args;
}

// Run rg over `root`, returning absolute paths of files whose contents match.
// Rejects on an rg error (exit 2) — e.g. a pattern rg's regex engine can't
// compile — so the caller can fall back to the JS path for that query.
export function searchWithRipgrep(
  rgCmd: string,
  root: string,
  params: RipgrepSearchParams,
): Promise<RipgrepSearchResult> {
  return new Promise((resolve, reject) => {
    const args = buildRipgrepArgs(root, params);

    const proc = spawn(rgCmd, args, { windowsHide: true });
    const collector = new RgPathCollector(root, params.limit);
    let stderr = '';
    let cancelled = false; // caller asked to stop (superseded request)
    let earlyKilled = false; // we killed rg after collecting enough
    let settled = false;

    const finish = (result: RipgrepSearchResult): void => {
      if (settled) return;
      settled = true;
      clearInterval(cancelTimer);
      resolve(result);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(cancelTimer);
      reject(err);
    };

    const cancelTimer = setInterval(() => {
      if (params.isCancelled?.() && !cancelled && !earlyKilled && !collector.done) {
        cancelled = true;
        proc.kill();
      }
    }, CANCEL_POLL_MS);

    proc.stdout.on('data', (d: Buffer) => {
      // Once cancelled/early-killed we don't decode further chunks — this is
      // what bounds memory when a broad query would otherwise match the repo.
      if (settled || cancelled || earlyKilled) return;
      if (collector.push(d)) {
        // Enough paths to know it's truncated — terminate rg now instead of
        // buffering the rest of its output. The intentional kill is
        // distinguished from a cancellation below (it resolves, not empties).
        earlyKilled = true;
        proc.kill();
      }
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => fail(err));
    proc.on('close', (code) => {
      if (cancelled) {
        // Superseded request — caller ignores the result; match prior behavior.
        finish({ matches: [], truncated: false });
        return;
      }
      if (earlyKilled || collector.done) {
        // We stopped rg deliberately after hitting the cap; the non-zero exit
        // from the kill is expected, not an error.
        finish({ matches: collector.matches, truncated: true });
        return;
      }
      if (code === RG_EXIT_ERROR) {
        fail(new Error(stderr.trim() || 'ripgrep error'));
        return;
      }
      collector.end();
      finish({ matches: collector.matches, truncated: collector.truncated });
    });
  });
}
