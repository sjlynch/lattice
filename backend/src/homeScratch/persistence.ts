// Durable mirror of the one-off run registries (push runs, QA e2e runs,
// post-merge hooks).
//
// Why this exists: those registries used to live ONLY in memory, while their
// agents' ptys live in the DETACHED terminal-server, which survives a backend
// restart. Lattice restarts itself routinely while it develops itself (`tsc -w`
// + the dev runner on every merged `backend/src` change, a crash, a
// processGuards fail-fast), so a restart during a push / QA / post-merge
// session left a still-working agent whose callback (`/done`, `/verdict`,
// `/complete`) then hit a backend that had never heard of it: a 404, a
// terminal idling forever, a QA pass that never promoted its task, and a
// post-merge hook the resumed merge run could not see (so it started a second
// one, or the workflow Merge step's Phase C read "idle" while it ran).
//
// So every RUNNING record is mirrored to
// `~/.lattice/per-project/<hash>/<fileName>` and re-adopted on boot by
// `../recovery/oneOffRunResume.ts`. Finished records are dropped (nothing to
// resume), so the file disappears when nothing is running.
//
// Same storage rules as `workflowRuns/persistence.ts`: HOME-scoped (never in
// the project tree — see the `.git`-deletion defences in the root CLAUDE.md),
// atomic temp→rename, writes serialized per project, and every failure is
// best-effort — losing the mirror must never break a live run. Unlike the
// workflow mirror there is no debounce: these records change a handful of
// times per run (record, verdict, done), and a restart inside a debounce
// window would resurrect a finished run as `running`, so each change is
// written straight away (coalesced while a write is queued).

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { canonicalProjectPath, homeProjectScratchDir } from '../projectPath.js';

export const ONE_OFF_RUNS_FILE_VERSION = 1;

type OneOffRunsFile<Run> = { version: number; runs: Run[] };

export type OneOffRunStore<Run> = {
  // Absolute mirror path for a project (for logs/tests).
  file(projectPath: string): string;
  // Read + validate the persisted records. Never throws; a missing or corrupt
  // file reads as [].
  load(projectPath: string): Promise<Run[]>;
  // Queue a write of `collect()`'s result. `collect` runs when the write
  // starts, so a burst of changes lands as one write of the latest state.
  persist(projectPath: string, collect: () => Run[]): void;
  // Wait for every queued/in-flight write (for one project, or all).
  flush(projectPath?: string): Promise<void>;
};

export function createOneOffRunStore<Run>(args: {
  fileName: string;
  logLabel: string;
  // Rebuild one record from untrusted JSON, or null to drop it. Must only
  // return records that are still resumable (i.e. `running`).
  deserialize: (raw: unknown, owningProject: string) => Run | null;
}): OneOffRunStore<Run> {
  // Per project: the tail of the write chain, and whether a write is queued
  // behind it that hasn't started yet (a further persist() joins that one).
  const chains = new Map<string, Promise<void>>();
  const queued = new Map<string, () => Run[]>();

  function file(projectPath: string): string {
    return homeProjectScratchDir(projectPath, args.fileName);
  }

  async function load(projectPath: string): Promise<Run[]> {
    let target: string;
    let raw: string;
    try {
      target = file(projectPath);
      raw = await fs.readFile(target, 'utf8');
    } catch (err) {
      // ENOENT is the normal "nothing was running" case.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`${args.logLabel} failed to read the ${args.fileName} mirror for ${projectPath}:`, err);
      }
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as OneOffRunsFile<unknown>).runs)
          ? (parsed as OneOffRunsFile<unknown>).runs
          : [];
      const out: Run[] = [];
      for (const entry of list) {
        const run = args.deserialize(entry, projectPath);
        if (run) out.push(run);
      }
      return out;
    } catch (err) {
      // Derived state a live run rewrites on its next change — not worth
      // preserving, but it must never throw into boot recovery.
      console.error(`${args.logLabel} ignoring unparseable ${target}:`, err);
      return [];
    }
  }

  async function write(projectPath: string, runs: Run[]): Promise<void> {
    try {
      const target = file(projectPath);
      if (runs.length === 0) {
        await fs.rm(target, { force: true });
        return;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const body: OneOffRunsFile<Run> = { version: ONE_OFF_RUNS_FILE_VERSION, runs };
      await atomicWriteFile(target, JSON.stringify(body, null, 2));
    } catch (err) {
      console.error(`${args.logLabel} failed to persist the ${args.fileName} mirror for ${projectPath}:`, err);
    }
  }

  function keyFor(projectPath: string): string | null {
    try {
      return canonicalProjectPath(projectPath);
    } catch (err) {
      console.error(`${args.logLabel} cannot resolve ${projectPath} for the ${args.fileName} mirror:`, err);
      return null;
    }
  }

  function persist(projectPath: string, collect: () => Run[]): void {
    const key = keyFor(projectPath);
    if (!key) return;
    const alreadyQueued = queued.has(key);
    queued.set(key, collect);
    if (alreadyQueued) return;
    // Serialized per project: atomic rename protects one write, not the order
    // of two — a slow "running" write must never land after a newer removal.
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(async () => {
      const latest = queued.get(key);
      queued.delete(key);
      if (!latest) return;
      let runs: Run[];
      try {
        runs = latest();
      } catch (err) {
        console.error(`${args.logLabel} failed to collect records for the ${args.fileName} mirror:`, err);
        return;
      }
      await write(key, runs);
    });
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  }

  async function flush(projectPath?: string): Promise<void> {
    const keys = projectPath ? [keyFor(projectPath)].filter((k): k is string => !!k) : [...chains.keys()];
    for (const key of keys) await chains.get(key);
  }

  return { file, load, persist, flush };
}

// ---------------------------------------------------------------------------
// Field readers for the per-feature deserializers. The mirror is on disk and
// could be stale, hand-edited or corrupt, so nothing is trusted from JSON.parse.
// ---------------------------------------------------------------------------

export function readString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

export function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
