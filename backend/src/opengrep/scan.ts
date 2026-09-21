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
import os from 'node:os';
import path from 'node:path';
import { IGNORE_DIR_NAMES } from '../health/constants.js';
import { canonicalProjectPath } from '../projectPath.js';
import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { resetOpengrepCache, resolveOpengrep, type OpengrepResolution } from './detect.js';
import { parseOpengrepJson, type OpengrepSeverity, type ParsedOpengrepOutput } from './digest.js';
import { projectRulesDir, projectScansDir, rulePackDir, rulesRootDir } from './paths.js';
import { readOpengrepState } from './state.js';
import { findRulePackDef } from './versions.js';

export const MAX_SCANS_PER_PROJECT = 10;
export const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60_000;
// Per-file rule timeout (seconds) handed to the engine, and how many timeouts
// on one file before the engine gives up on it.
const PER_FILE_TIMEOUT_S = 30;
const PER_FILE_TIMEOUT_THRESHOLD = 3;
const MAX_TARGET_BYTES = 1_000_000;

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
};

export type OpengrepScanRecord = {
  id: string;
  project: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  engine: { version: string; source: OpengrepResolution['source'] };
  packIds: string[];
  rulePaths: string[];
  targets: string[];
  exitCode: number | null;
  // RAW (unfiltered) counts, so the Settings summary and the digest agree on
  // what the engine saw regardless of the project's filter.
  findings: number;
  bySeverity: Record<OpengrepSeverity, number>;
  scannedFiles: number;
  errors: number;
  partiallyParsed: number;
  jsonFile: string;
};

export type ScanDeps = {
  resolve?: () => Promise<OpengrepResolution | null>;
  spawn?: typeof spawnWithTimeout;
  cpuCount?: number;
};

const running = new Map<string, Promise<OpengrepScanRecord>>();

export function isOpengrepScanRunning(project: string): boolean {
  return running.has(canonicalProjectPath(project));
}

// Any project at all — the rule-pack routes refuse to swap or delete a pack
// directory while an engine process may be reading it.
export function isAnyOpengrepScanRunning(): boolean {
  return running.size > 0;
}

export class OpengrepBadTargetError extends Error {}

// The `targets` an API / MCP caller passes are project-relative sub-paths. They
// are resolved against the project and must stay inside it: a `../../etc` (or
// an absolute path elsewhere) would scan — and put into the stored record —
// files outside the project the caller is scoped to. Duplicates and `.` /
// empty entries collapse to the project root.
export function resolveScanTargets(project: string, targets: string[] | undefined): { abs: string[]; rel: string[] } {
  const cleaned = (targets ?? []).map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return { abs: [project], rel: ['.'] };
  const abs: string[] = [];
  const rel: string[] = [];
  const seen = new Set<string>();
  for (const t of cleaned) {
    const resolved = path.resolve(project, t);
    const relative = path.relative(project, resolved);
    // `..` itself or a `../…` prefix escapes; a subdirectory literally named
    // `..foo` does not (hence the separator check), and a different drive
    // comes back absolute.
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new OpengrepBadTargetError(`target ${JSON.stringify(t)} is outside the project`);
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    abs.push(resolved);
    rel.push(relative ? relative.replace(/\\/g, '/') : '.');
  }
  // The whole project subsumes every other target.
  if (rel.includes('.')) return { abs: [project], rel: ['.'] };
  return { abs, rel };
}

export function defaultScanJobs(cpuCount = os.cpus().length): number {
  return Math.max(1, cpuCount - 2);
}

function scanId(): string {
  return `og_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// The `-f` arguments: installed packs as RELATIVE ids (cwd is the rules root),
// the project's own rules dir, and any configured extra paths, as absolutes.
export async function resolveRuleConfigs(
  project: string,
  packIds: string[],
  extraRulePaths: string[] = [],
): Promise<{ rulePaths: string[]; packIds: string[] }> {
  const state = await readOpengrepState();
  const rulePaths: string[] = [];
  const used: string[] = [];
  for (const id of packIds) {
    if (!findRulePackDef(id) || !state.packs[id]) continue;
    if (!(await isDir(rulePackDir(id)))) continue;
    rulePaths.push(id);
    used.push(id);
  }
  const own = projectRulesDir(project);
  if (await isDir(own)) rulePaths.push(own);
  for (const p of extraRulePaths) {
    const abs = path.isAbsolute(p) ? p : path.join(project, p);
    if (await exists(abs)) rulePaths.push(abs);
  }
  return { rulePaths, packIds: used };
}

export function buildScanArgs(opts: {
  rulePaths: string[];
  excludeGlobs: string[];
  jobs: number;
  outFile: string;
  targets: string[];
}): string[] {
  const args = [
    'scan',
    '--json',
    '--quiet',
    `--jobs=${opts.jobs}`,
    `--timeout=${PER_FILE_TIMEOUT_S}`,
    `--timeout-threshold=${PER_FILE_TIMEOUT_THRESHOLD}`,
    `--max-target-bytes=${MAX_TARGET_BYTES}`,
  ];
  for (const g of opts.excludeGlobs) args.push(`--exclude=${g}`);
  for (const r of opts.rulePaths) args.push('-f', r);
  args.push('-o', opts.outFile);
  args.push(...opts.targets);
  return args;
}

// Exclude globs sent on every scan: the directories the graph scan skips too
// (build output, caches, `.lattice/`), so an un-gitignored `dist/` is not
// scanned as if it were source. `.git` is never a target anyway.
export function defaultExcludeGlobs(): string[] {
  return [...IGNORE_DIR_NAMES].filter((d) => d !== '.git');
}

async function performScan(req: OpengrepScanRequest, project: string, deps: ScanDeps): Promise<OpengrepScanRecord> {
  // Validate the caller's input before touching the engine so a bad target is
  // a 400-class error, not a half-started scan.
  const targets = resolveScanTargets(project, req.targets);
  const resolved = await (deps.resolve ?? resolveOpengrep)();
  if (!resolved) throw new OpengrepNotInstalledError();
  const { rulePaths, packIds } = await resolveRuleConfigs(project, req.packIds, req.extraRulePaths ?? []);
  if (rulePaths.length === 0) throw new OpengrepNoRulesError();

  const dir = projectScansDir(project);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(rulesRootDir(), { recursive: true });
  const id = scanId();
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
  });
  const finishedAt = Date.now();
  if (r.error) {
    await fs.rm(jsonFile, { force: true }).catch(() => {});
    // A binary that was there at resolve time and is gone now (uninstalled,
    // quarantined): drop the memoized resolution so the next status call
    // reports "not installed" instead of repeating this failure.
    if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') resetOpengrepCache();
    throw new OpengrepScanFailedError(`opengrep failed to start: ${r.error.message}`);
  }
  if (r.timedOut) {
    await fs.rm(jsonFile, { force: true }).catch(() => {});
    throw new OpengrepScanFailedError(
      `opengrep scan timed out after ${Math.round(timeoutMs / 1000)}s and was killed. Narrow the targets or exclude large directories.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
  } catch (err) {
    await fs.rm(jsonFile, { force: true }).catch(() => {});
    throw new OpengrepScanFailedError(
      `opengrep exited ${r.code} without a readable JSON report${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 800)}` : ''}` +
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

export function runOpengrepScan(req: OpengrepScanRequest, deps: ScanDeps = {}): Promise<OpengrepScanRecord> {
  const project = canonicalProjectPath(req.project);
  if (running.has(project)) return Promise.reject(new OpengrepScanBusyError(project));
  const p = performScan(req, project, deps).finally(() => {
    // Only clear our own entry: a caller that raced in after this scan's
    // rejection settled must not have its fresh entry removed.
    if (running.get(project) === p) running.delete(project);
  });
  running.set(project, p);
  return p;
}

async function readMeta(file: string): Promise<OpengrepScanRecord | null> {
  try {
    const rec = JSON.parse(await fs.readFile(file, 'utf8')) as OpengrepScanRecord;
    return rec && typeof rec.id === 'string' ? rec : null;
  } catch {
    return null;
  }
}

export async function listOpengrepScans(project: string): Promise<OpengrepScanRecord[]> {
  const dir = projectScansDir(canonicalProjectPath(project));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas = await Promise.all(
    names.filter((n) => n.endsWith('.meta.json')).map((n) => readMeta(path.join(dir, n))),
  );
  return metas
    .filter((m): m is OpengrepScanRecord => !!m)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function readOpengrepScan(
  project: string,
  id: string,
): Promise<{ record: OpengrepScanRecord; parsed: ParsedOpengrepOutput } | null> {
  if (!/^og_[a-z0-9_]+$/i.test(id)) return null;
  const canonical = canonicalProjectPath(project);
  const dir = projectScansDir(canonical);
  const record = await readMeta(path.join(dir, `${id}.meta.json`));
  if (!record) return null;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
    return { record, parsed: parseOpengrepJson(raw, canonical) };
  } catch {
    return null;
  }
}

export async function latestOpengrepScan(project: string): Promise<OpengrepScanRecord | null> {
  return (await listOpengrepScans(project))[0] ?? null;
}

async function pruneOldScans(dir: string, keep: number): Promise<void> {
  const names = await fs.readdir(dir);
  const metas = (
    await Promise.all(names.filter((n) => n.endsWith('.meta.json')).map((n) => readMeta(path.join(dir, n))))
  ).filter((m): m is OpengrepScanRecord => !!m);
  metas.sort((a, b) => b.startedAt - a.startedAt);
  for (const old of metas.slice(keep)) {
    await fs.rm(path.join(dir, `${old.id}.meta.json`), { force: true });
    await fs.rm(path.join(dir, `${old.id}.json`), { force: true });
  }
}
