// A project's stored scans under `~/.lattice/per-project/<hash>/opengrep/`:
// `<id>.json` (the engine's raw output) + `<id>.meta.json` (the record). Read,
// list, latest, and the prune that keeps the last MAX_SCANS_PER_PROJECT.
// scan.ts re-exports everything here, so callers keep importing from it.

import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from '../projectPath.js';
import type { OpengrepResolution } from './detect.js';
import { parseOpengrepJson, type OpengrepSeverity, type ParsedOpengrepOutput } from './digest.js';
import { projectScansDir } from './paths.js';

export const MAX_SCANS_PER_PROJECT = 10;

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

async function readMeta(file: string): Promise<OpengrepScanRecord | null> {
  try {
    const rec = JSON.parse(await fs.readFile(file, 'utf8')) as OpengrepScanRecord;
    return rec && typeof rec.id === 'string' ? rec : null;
  } catch {
    return null;
  }
}

// Every readable record in `dir`, newest first. Rejects when `dir` itself
// cannot be listed; an unreadable meta file is skipped.
async function readAllMetas(dir: string): Promise<OpengrepScanRecord[]> {
  const names = await fs.readdir(dir);
  const metas = await Promise.all(
    names.filter((n) => n.endsWith('.meta.json')).map((n) => readMeta(path.join(dir, n))),
  );
  return metas
    .filter((m): m is OpengrepScanRecord => !!m)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function listOpengrepScans(project: string): Promise<OpengrepScanRecord[]> {
  const dir = projectScansDir(canonicalProjectPath(project));
  try {
    return await readAllMetas(dir);
  } catch {
    return [];
  }
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

export async function pruneOldScans(dir: string, keep: number): Promise<void> {
  const metas = await readAllMetas(dir);
  for (const old of metas.slice(keep)) {
    await fs.rm(path.join(dir, `${old.id}.meta.json`), { force: true });
    await fs.rm(path.join(dir, `${old.id}.json`), { force: true });
  }
}
