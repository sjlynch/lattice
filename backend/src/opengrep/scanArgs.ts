// What one Opengrep scan runs against and with: the caller's targets (confined
// to the project), the `-f` rule configs, the `--jobs` default, and the engine
// command line. Pure except for the filesystem probes in resolveRuleConfigs.
// scan.ts re-exports everything here, so callers keep importing from it.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IGNORE_DIR_NAMES } from '../health/constants.js';
import { projectRulesDir, rulePackDir } from './paths.js';
import { readOpengrepState } from './state.js';
import { findRulePackDef } from './versions.js';

// Per-file rule timeout (seconds) handed to the engine, and how many timeouts
// on one file before the engine gives up on it.
const PER_FILE_TIMEOUT_S = 30;
const PER_FILE_TIMEOUT_THRESHOLD = 3;
const MAX_TARGET_BYTES = 1_000_000;
// Cores left free for the agents and the dev server while a scan runs
// (`--jobs = max(1, cores - RESERVED_CORES)`).
const RESERVED_CORES = 2;

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
  return Math.max(1, cpuCount - RESERVED_CORES);
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
