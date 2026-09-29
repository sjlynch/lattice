// Rule packs: fetch a pinned commit of a third-party rules repository into
// `~/.lattice/opengrep/rules/<packId>/`, prune everything that is not a rule
// (and every folder whose licence we do not want to carry), and record what
// was kept in state.json.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchPackCommit } from './rulePackFetch.js';
import { rulePackDir, rulesRootDir } from './paths.js';
import { RulePackError } from './rulePackError.js';
import { prunePackTree, sweepStalePackDirs } from './rulePackTree.js';
import { withRulesMutation } from './rulesGate.js';
import { readOpengrepState, updateOpengrepState, type OpengrepPackState } from './state.js';
import {
  OPENGREP_RULE_PACKS,
  findRulePackDef,
  type OpengrepRulePackDef,
} from './versions.js';

// Fetching and tree filtering live in their own modules; re-exported so
// every existing `./rules.js` import keeps working with the same error class.
export { RulePackError } from './rulePackError.js';
export { fetchPackCommit } from './rulePackFetch.js';
export { prunePackTree, sweepStalePackDirs } from './rulePackTree.js';

export type RulePackJob = {
  status: 'running' | 'done' | 'failed';
  packId: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
};

export type RulePackStatus = OpengrepRulePackDef & {
  dir: string;
  installed: OpengrepPackState | null;
  // True when the installed commit differs from the pinned one (a Lattice
  // upgrade moved the pin) — the Settings card offers "Update".
  outdated: boolean;
  job: RulePackJob | null;
};

// Test seam: the fetch step (a real `git fetch` otherwise).
export type RulePackDeps = {
  fetchCommit?: (repo: string, commit: string, dest: string) => Promise<void>;
};

type InFlightInstall = {
  promise: Promise<OpengrepPackState>;
  // Set by removeRulePack while this install runs: the install discards its
  // tree instead of swapping it in, so a removal is never silently undone.
  cancelled: boolean;
};

const jobs = new Map<string, RulePackJob>();
const inFlight = new Map<string, InFlightInstall>();

export function getRulePackJob(packId: string): RulePackJob | null {
  return jobs.get(packId) ?? null;
}

// True while `installRulePack(packId)` is fetching / pruning / swapping. The
// DELETE route refuses (409) while it is.
export function isRulePackInstalling(packId: string): boolean {
  return inFlight.has(packId);
}

async function performInstall(
  def: OpengrepRulePackDef,
  install: InFlightInstall,
  deps: RulePackDeps,
): Promise<OpengrepPackState> {
  const root = rulesRootDir();
  await fs.mkdir(root, { recursive: true });
  await sweepStalePackDirs(root, def.id);
  const finalDir = rulePackDir(def.id);
  const tmp = path.join(root, `.tmp-${def.id}-${process.pid}-${Date.now()}`);
  const old = path.join(root, `.old-${def.id}-${Date.now()}`);
  try {
    await (deps.fetchCommit ?? fetchPackCommit)(def.repo, def.commit, tmp);
    const counts = await prunePackTree(tmp, def.prune);
    if (counts.ruleFiles === 0) {
      throw new RulePackError(`pack ${def.id} contained no rule files after pruning`);
    }
    // The swap and the state write hold the rules tree exclusively (see
    // rulesGate.ts): a scan already running finishes first — its engine is
    // reading these files — and one starting now waits for the swap instead of
    // seeing half a pack. The route's request-time "no scan running" check is
    // only a fast path; the fetch above takes seconds to minutes.
    return await withRulesMutation(
      async () => {
        // Removed while we were fetching: honour the removal rather than
        // resurrecting the pack a moment after the user deleted it.
        if (install.cancelled) {
          throw new RulePackError(`rule pack ${def.id} was removed while it was installing; not installing it`);
        }
        // Swap: move any previous install aside, then the new tree into place.
        // If the second rename fails (Windows EBUSY, a permissions hiccup) the
        // previous install is put back so an update attempt can never leave
        // the user with NO pack.
        let movedAside = false;
        try {
          await fs.rename(finalDir, old);
          movedAside = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
        try {
          await fs.rename(tmp, finalDir);
        } catch (err) {
          if (movedAside) await fs.rename(old, finalDir).catch(() => {});
          throw err;
        }
        await fs.rm(old, { recursive: true, force: true }).catch(() => {});
        const entry: OpengrepPackState = {
          commit: def.commit,
          ruleFiles: counts.ruleFiles,
          ruleCount: counts.ruleCount,
          licence: def.licence,
          installedAt: Date.now(),
        };
        await updateOpengrepState((s) => ({ ...s, packs: { ...s.packs, [def.id]: entry } }));
        console.log(
          `[opengrep] rule pack ${def.id}@${def.commit.slice(0, 10)} installed: ` +
            `${counts.ruleFiles} files, ${counts.ruleCount} rules`,
        );
        return entry;
      },
      { wait: true },
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Install (or re-install at the pinned commit) one pack. Single-flight per
// pack; a second call while running joins the first.
export function installRulePack(packId: string, deps: RulePackDeps = {}): Promise<OpengrepPackState> {
  const def = findRulePackDef(packId);
  if (!def) return Promise.reject(new RulePackError(`unknown rule pack: ${packId}`));
  const running = inFlight.get(packId);
  if (running) return running.promise;
  const job: RulePackJob = { status: 'running', packId, startedAt: Date.now() };
  jobs.set(packId, job);
  const install: InFlightInstall = { promise: undefined as unknown as Promise<OpengrepPackState>, cancelled: false };
  install.promise = performInstall(def, install, deps)
    .then((entry) => {
      job.status = 'done';
      job.finishedAt = Date.now();
      return entry;
    })
    .catch((err: unknown) => {
      job.status = 'failed';
      job.finishedAt = Date.now();
      job.error = err instanceof Error ? err.message : String(err);
      console.warn(`[opengrep] rule pack ${packId} install failed: ${job.error}`);
      throw err;
    })
    .finally(() => {
      if (inFlight.get(packId) === install) inFlight.delete(packId);
    });
  inFlight.set(packId, install);
  return install.promise;
}

export async function listRulePacks(): Promise<RulePackStatus[]> {
  const state = await readOpengrepState();
  return OPENGREP_RULE_PACKS.map((def) => {
    const installed = state.packs[def.id] ?? null;
    return {
      ...def,
      dir: rulePackDir(def.id),
      installed,
      outdated: !!installed && installed.commit !== def.commit,
      job: getRulePackJob(def.id),
    };
  });
}

// Removes an installed pack (the directory + its state entry). Only ever
// deletes under the rules root Lattice owns. Refuses with
// OpengrepRulesBusyError (→ 409) while a scan is running rather than delete a
// tree an engine is reading; a scan starting meanwhile waits for it. A still
// running install of the same pack is cancelled (it discards its tree instead
// of swapping it in): the DELETE route refuses before getting here, and this
// keeps any other caller from having its removal silently undone.
export async function removeRulePack(packId: string): Promise<void> {
  const def = findRulePackDef(packId);
  if (!def) throw new RulePackError(`unknown rule pack: ${packId}`);
  await withRulesMutation(
    async () => {
      const installing = inFlight.get(packId);
      if (installing) installing.cancelled = true;
      await fs.rm(rulePackDir(packId), { recursive: true, force: true });
      await updateOpengrepState((s) => {
        const packs = { ...s.packs };
        delete packs[packId];
        return { ...s, packs };
      });
    },
    { wait: false },
  );
}
