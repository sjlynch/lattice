// Runs one Opengrep scan of a project and stores the result.
//
//   opengrep scan --json --quiet --jobs N --timeout 30 … -f <pack> … -o <raw.json> <project>
//
// with cwd = the rules root (see paths.ts — that is what keeps check ids and
// fingerprints stable), the JSON written by the engine straight to
// `~/.lattice/per-project/<hash>/opengrep/<scanId>.json`, and a small
// `<scanId>.meta.json` beside it. The last MAX_SCANS_PER_PROJECT are kept.
//
// Bounded on purpose: one scan per project at a time (a second request gets
// OpengrepScanBusyError → 409), `--jobs` capped at cores-2 so agents and the
// dev server stay responsive, a hard wall-clock timeout after which the child
// is killed, per-file `--timeout`, and `--max-target-bytes`. Never triggered
// by the file watcher — only by a workflow step, the Settings button, the API
// or the MCP tool.

import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { resetOpengrepCache, resolveOpengrep, type OpengrepResolution } from './detect.js';
import { parseOpengrepJson, type OpengrepSeverity } from './digest.js';
import { projectScansDir, rulesRootDir } from './paths.js';
import { acquireRulesRead } from './rulesGate.js';
import {
  buildScanArgs,
  defaultExcludeGlobs,
  defaultScanJobs,
  resolveRuleConfigs,
  resolveScanTargets,
} from './scanArgs.js';
import { MAX_SCANS_PER_PROJECT, pruneOldScans, type OpengrepScanRecord } from './scanRecords.js';

// Target + argument building and stored-record access live in their own
// modules; re-exported so every existing `./scan.js` import keeps working.
export {
  OpengrepBadTargetError,
  buildScanArgs,
  defaultExcludeGlobs,
  defaultScanJobs,
  resolveRuleConfigs,
  resolveScanTargets,
} from './scanArgs.js';
export {
  MAX_SCANS_PER_PROJECT,
  latestOpengrepScan,
  listOpengrepScans,
  readOpengrepScan,
  type OpengrepScanRecord,
} from './scanRecords.js';

export const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60_000;
// Random base-36 characters after the timestamp in a scan id (`og_<ts>_<rand>`).
const SCAN_ID_SUFFIX_LENGTH = 6;
// How much of the engine's stderr a "no readable JSON report" error quotes.
const STDERR_EXCERPT_MAX_CHARS = 800;

export class OpengrepNotInstalledError extends Error {
  constructor() {
    super(
      'Opengrep is not installed. Install it in Settings → Tools (or put an `opengrep` binary on PATH) and try again.',
    );
  }
}
export class OpengrepScanBusyError extends Error {
  constructor(project: string) {
    super(`an Opengrep scan is already running for ${project}`);
  }
}
export class OpengrepNoRulesError extends Error {
  constructor() {
    super(
      'No Opengrep rules are available: install and enable at least one rule pack in Settings → Tools, ' +
        'or add rules under <project>/.opengrep/rules/.',
    );
  }
}
export class OpengrepScanFailedError extends Error {}
// The caller's AbortSignal fired (a workflow run was cancelled mid-scan, or the
// backend is exiting): the engine was killed and nothing was stored.
export class OpengrepScanAbortedError extends OpengrepScanFailedError {
  constructor() {
    super('the Opengrep scan was cancelled before it finished');
  }
}

export type OpengrepScanRequest = {
  project: string;
  // Pack ids to use. Only packs that are actually installed are passed to the
  // engine; the record lists what was used.
  packIds: string[];
  // Extra rule files/dirs: absolute, or relative to the project.
  extraRulePaths?: string[];
  excludeGlobs?: string[];
  jobs?: number;
  timeoutMs?: number;
  // Project-relative sub-paths to scan instead of the whole project.
  targets?: string[];
  // Cancels the scan: the engine is killed, nothing is stored, and the call
  // rejects with OpengrepScanAbortedError.
  signal?: AbortSignal;
};

export type ScanDeps = {
  resolve?: () => Promise<OpengrepResolution | null>;
  spawn?: typeof spawnWithTimeout;
  cpuCount?: number;
};

type RunningScan = { id: string; startedAt: number; promise: Promise<OpengrepScanRecord>; abort: AbortController };
const running = new Map<string, RunningScan>();

// The last few scans that FAILED, by id, so a caller that started one with
// `startOpengrepScan` and polls for it (the MCP tool, via `GET
// /api/opengrep/scans/:id`) learns why instead of seeing an unknown id. A
// successful scan needs no entry: its record is on disk.
const RECENT_FAILURES_KEPT = 20;
const recentFailures = new Map<string, { project: string; error: Error }>();

function rememberFailure(id: string, project: string, err: unknown): void {
  recentFailures.set(id, { project, error: err instanceof Error ? err : new Error(String(err)) });
  while (recentFailures.size > RECENT_FAILURES_KEPT) {
    const oldest = recentFailures.keys().next().value;
    if (oldest === undefined) break;
    recentFailures.delete(oldest);
  }
}

export type OpengrepScanRunState =
  | { state: 'running'; id: string; startedAt: number }
  | { state: 'failed'; id: string; error: Error };

// Is scan `id` of `project` still running, or did it fail? `null` when this
// backend knows nothing about it in memory (finished and stored — read it with
// readOpengrepScan — or never started here, e.g. before a restart).
export function opengrepScanRunState(project: string, id: string): OpengrepScanRunState | null {
  const canonical = canonicalProjectPath(project);
  const entry = running.get(canonical);
  if (entry && entry.id === id) return { state: 'running', id, startedAt: entry.startedAt };
  const failed = recentFailures.get(id);
  if (failed && failed.project === canonical) return { state: 'failed', id, error: failed.error };
  return null;
}

export function isOpengrepScanRunning(project: string): boolean {
  return running.has(canonicalProjectPath(project));
}

// Read-only metadata lets a refreshed graph reconnect to the exact scan.
export function runningOpengrepScan(project: string): { id: string; startedAt: number } | null {
  const entry = running.get(canonicalProjectPath(project));
  return entry ? { id: entry.id, startedAt: entry.startedAt } : null;
}

// Any project at all — the rule-pack routes refuse to swap or delete a pack
// directory while an engine process may be reading it.
export function isAnyOpengrepScanRunning(): boolean {
  return running.size > 0;
}

// Kill the project's in-flight scan (if any). The awaiting caller gets
// OpengrepScanAbortedError and the busy slot frees at once, so a workflow run
// cancelled mid-scan does not leave the project "busy" for the next run.
export function abortOpengrepScan(project: string): boolean {
  const entry = running.get(canonicalProjectPath(project));
  if (!entry) return false;
  entry.abort.abort();
  return true;
}

// The chip cancels an exact id and waits for the engine to settle. A stale
// browser must never cancel a newer scan that took the same project's slot.
export async function cancelOpengrepScan(project: string, id: string): Promise<boolean> {
  const entry = running.get(canonicalProjectPath(project));
  if (!entry || entry.id !== id) return false;
  entry.abort.abort();
  await entry.promise.catch(() => {});
  return true;
}

// The engine is a plain child process; when this backend exits (a dev-runner
// restart, a fail-fast) nothing else would reap it, and its `-o` file would
// land as an orphan without a record. `child.kill()` is synchronous, so an
// 'exit' handler is enough.
process.once('exit', () => {
  for (const entry of running.values()) entry.abort.abort();
});

// The engine's `-o` file of a scan that will not be recorded (cancelled,
// failed to start, timed out, unreadable). Best-effort, like every cleanup here.
async function discardRawOutput(jsonFile: string): Promise<void> {
  await fs.rm(jsonFile, { force: true }).catch(() => {});
}

function scanId(): string {
  return `og_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 2 + SCAN_ID_SUFFIX_LENGTH)}`;
}

async function performScan(
  req: OpengrepScanRequest,
  project: string,
  id: string,
  deps: ScanDeps,
  signal: AbortSignal,
): Promise<OpengrepScanRecord> {
  // Validate the caller's input before touching the engine so a bad target is
  // a 400-class error, not a half-started scan.
  const targets = resolveScanTargets(project, req.targets);
  if (signal.aborted) throw new OpengrepScanAbortedError();
  const resolved = await (deps.resolve ?? resolveOpengrep)();
  if (!resolved) throw new OpengrepNotInstalledError();

  // Hold a read slot on the rules tree from resolving the packs until the scan
  // is stored, so a pack install cannot swap (or a removal delete) a tree this
  // scan's engine is reading — the scan waits out a swap in progress instead
  // (rulesGate.ts). Waiting is abortable like the rest of the scan.
  let releaseRules: () => void;
  try {
    releaseRules = await acquireRulesRead(signal);
  } catch {
    throw new OpengrepScanAbortedError();
  }
  try {
    return await scanWithRules(req, project, id, deps, signal, targets, resolved);
  } finally {
    releaseRules();
  }
}

async function scanWithRules(
  req: OpengrepScanRequest,
  project: string,
  id: string,
  deps: ScanDeps,
  signal: AbortSignal,
  targets: { abs: string[]; rel: string[] },
  resolved: OpengrepResolution,
): Promise<OpengrepScanRecord> {
  const { rulePaths, packIds } = await resolveRuleConfigs(project, req.packIds, req.extraRulePaths ?? []);
  if (rulePaths.length === 0) throw new OpengrepNoRulesError();

  const dir = projectScansDir(project);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(rulesRootDir(), { recursive: true });
  const jsonFile = path.join(dir, `${id}.json`);
  const excludeGlobs = [...new Set([...defaultExcludeGlobs(), ...(req.excludeGlobs ?? [])])];
  const jobs = req.jobs && req.jobs > 0 ? Math.floor(req.jobs) : defaultScanJobs(deps.cpuCount);
  const args = buildScanArgs({ rulePaths, excludeGlobs, jobs, outFile: jsonFile, targets: targets.abs });
  const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_SCAN_TIMEOUT_MS;

  const startedAt = Date.now();
  console.log(`[opengrep] scan ${id} start: ${project} (${rulePaths.length} rule sources, jobs=${jobs})`);
  const r = await (deps.spawn ?? spawnWithTimeout)(resolved.command, args, {
    cwd: rulesRootDir(),
    timeoutMs,
    signal,
  });
  const finishedAt = Date.now();
  if (r.aborted) {
    await discardRawOutput(jsonFile);
    console.log(`[opengrep] scan ${id} cancelled after ${finishedAt - startedAt}ms`);
    throw new OpengrepScanAbortedError();
  }
  if (r.error) {
    await discardRawOutput(jsonFile);
    // A binary that was there at resolve time and is gone now (uninstalled,
    // quarantined): drop the memoized resolution so the next status call
    // reports "not installed" instead of repeating this failure.
    if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') resetOpengrepCache();
    throw new OpengrepScanFailedError(`opengrep failed to start: ${r.error.message}`);
  }
  if (r.timedOut) {
    await discardRawOutput(jsonFile);
    throw new OpengrepScanFailedError(
      `opengrep scan timed out after ${Math.round(timeoutMs / 1000)}s and was killed. Narrow the targets or exclude large directories.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  } catch (err) {
    await discardRawOutput(jsonFile);
    throw new OpengrepScanFailedError(
      `opengrep exited ${r.code} without a readable JSON report${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, STDERR_EXCERPT_MAX_CHARS)}` : ''}` +
        (`${err}`.includes('ENOENT') ? '' : ` (${(err as Error).message})`),
    );
  }
  const parsed = parseOpengrepJson(raw, project);
  const bySeverity: Record<OpengrepSeverity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const f of parsed.findings) bySeverity[f.severity] += 1;
  const record: OpengrepScanRecord = {
    id,
    project,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    engine: { version: resolved.version, source: resolved.source },
    packIds,
    rulePaths,
    targets: targets.rel,
    exitCode: r.code,
    findings: parsed.findings.length,
    bySeverity,
    scannedFiles: parsed.scannedFiles,
    errors: parsed.errors.length,
    partiallyParsed: parsed.partiallyParsed.length,
    jsonFile,
  };
  await fs.writeFile(path.join(dir, `${id}.meta.json`), JSON.stringify(record, null, 2), 'utf8');
  await pruneOldScans(dir, MAX_SCANS_PER_PROJECT).catch(() => {});
  console.log(
    `[opengrep] scan ${id} done in ${record.durationMs}ms: ${record.findings} findings ` +
      `(${bySeverity.ERROR}E/${bySeverity.WARNING}W/${bySeverity.INFO}I), ${record.scannedFiles} files, exit ${r.code}`,
  );
  return record;
}

// Start a scan and return its id at once, with the promise of its record. The
// id is what the stored record will carry, so a caller can hand it out before
// the scan finishes and poll `opengrepScanRunState` / `readOpengrepScan`.
// Throws OpengrepScanBusyError synchronously when the project already has one.
export function startOpengrepScan(
  req: OpengrepScanRequest,
  deps: ScanDeps = {},
): { id: string; promise: Promise<OpengrepScanRecord> } {
  const project = canonicalProjectPath(req.project);
  if (running.has(project)) throw new OpengrepScanBusyError(project);
  const abort = new AbortController();
  if (req.signal) {
    if (req.signal.aborted) abort.abort();
    else req.signal.addEventListener('abort', () => abort.abort(), { once: true });
  }
  const id = scanId();
  const entry: RunningScan = {
    id,
    startedAt: Date.now(),
    promise: undefined as unknown as Promise<OpengrepScanRecord>,
    abort,
  };
  entry.promise = performScan(req, project, id, deps, abort.signal)
    .catch((err: unknown) => {
      rememberFailure(id, project, err);
      throw err;
    })
    .finally(() => {
      // Only clear our own entry: a caller that raced in after this scan's
      // rejection settled must not have its fresh entry removed.
      if (running.get(project) === entry) running.delete(project);
    });
  running.set(project, entry);
  return { id, promise: entry.promise };
}

export function runOpengrepScan(req: OpengrepScanRequest, deps: ScanDeps = {}): Promise<OpengrepScanRecord> {
  try {
    return startOpengrepScan(req, deps).promise;
  } catch (err) {
    return Promise.reject(err);
  }
}
