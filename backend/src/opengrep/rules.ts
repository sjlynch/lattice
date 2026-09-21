// Rule packs: fetch a pinned commit of a third-party rules repository into
// `~/.lattice/opengrep/rules/<packId>/`, prune everything that is not a rule
// (and every folder whose licence we do not want to carry), and record what
// was kept in state.json.
//
// Pinned by COMMIT, fetched with git: `git fetch --depth 1 origin <sha>` +
// `checkout FETCH_HEAD` yields a content-addressed tree, so the pin verifies
// the content by construction (unlike a tarball, whose bytes GitHub does not
// keep stable). Rules are data the engine interprets — the threat is "wrong
// rules", not code execution — so the commit pin is proportionate.
//
// Pruning keeps ONLY `*.yaml` / `*.yml` files that contain a top-level
// `rules:` key and are not `*.test.yaml` fixtures, plus the pack's LICENSE /
// README so the licence text travels with the rules. That drops the test
// sources, CI config, scripts, stats and — per pack `prune` — the folders
// carrying a licence the default pack must not (see versions.ts).

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { rulePackDir, rulesRootDir } from './paths.js';
import { readOpengrepState, updateOpengrepState, type OpengrepPackState } from './state.js';
import {
  OPENGREP_RULE_PACKS,
  findRulePackDef,
  type OpengrepRulePackDef,
} from './versions.js';

const GIT_TIMEOUT_MS = 5 * 60_000;

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

export class RulePackError extends Error {}

const jobs = new Map<string, RulePackJob>();
const inFlight = new Map<string, Promise<OpengrepPackState>>();

export function getRulePackJob(packId: string): RulePackJob | null {
  return jobs.get(packId) ?? null;
}

async function git(args: string[], cwd: string): Promise<string> {
  const r = await spawnWithTimeout('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  if (r.error) throw new RulePackError(`git ${args[0]} failed to start: ${r.error.message}`);
  if (r.timedOut) throw new RulePackError(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s`);
  if (r.code !== 0) {
    throw new RulePackError(`git ${args.join(' ')} exited ${r.code}: ${r.stderr.trim().slice(0, 600)}`);
  }
  return r.stdout;
}

// Fetch exactly `commit` from `repo` into `dest` (created). GitHub serves
// fetches by full SHA (uploadpack.allowReachableSHA1InWant), which is what
// makes a shallow fetch of one pinned commit possible without cloning history.
export async function fetchPackCommit(repo: string, commit: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  await git(['init', '-q'], dest);
  await git(['remote', 'add', 'origin', repo], dest);
  await git(
    ['-c', 'core.longpaths=true', '-c', 'advice.detachedHead=false', 'fetch', '-q', '--depth', '1', 'origin', commit],
    dest,
  );
  await git(['-c', 'core.longpaths=true', 'checkout', '-q', 'FETCH_HEAD'], dest);
  const head = (await git(['rev-parse', 'HEAD'], dest)).trim();
  if (head !== commit) {
    throw new RulePackError(`checked out ${head}, expected pinned commit ${commit}`);
  }
  // The `.git` directory is not needed once checked out: the pack is read-only
  // data from here on. Removing it is a recursive delete of a directory this
  // module just created under ~/.lattice — never a project tree.
  await fs.rm(path.join(dest, '.git'), { recursive: true, force: true });
}

const KEEP_ROOT_FILES = /^(LICENSE|LICENCE|COPYING|README)(\..*)?$/i;
const RULE_EXT = /\.ya?ml$/i;
const TEST_FIXTURE = /\.test\.ya?ml$/i;

async function looksLikeRuleFile(file: string): Promise<boolean> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return /^rules\s*:/m.test(text);
  } catch {
    return false;
  }
}

// Removes everything that is not a rule file (see the header). Returns the
// number of rule files kept and the `- id:` entries counted across them. Pure
// with respect to the tree it is given — tested on a fixture tree.
export async function prunePackTree(
  root: string,
  prune: readonly string[],
): Promise<{ ruleFiles: number; ruleCount: number }> {
  for (const rel of prune) {
    await fs.rm(path.join(root, ...rel.split('/')), { recursive: true, force: true });
  }
  let ruleFiles = 0;
  let ruleCount = 0;
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    let kept = false;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) {
          await fs.rm(full, { recursive: true, force: true });
          continue;
        }
        const childKept = await walk(full, depth + 1);
        if (!childKept) await fs.rm(full, { recursive: true, force: true });
        kept ||= childKept;
        continue;
      }
      if (depth === 0 && KEEP_ROOT_FILES.test(entry.name)) {
        kept = true;
        continue;
      }
      const isRule =
        entry.isFile() &&
        RULE_EXT.test(entry.name) &&
        !TEST_FIXTURE.test(entry.name) &&
        !entry.name.startsWith('.') &&
        (await looksLikeRuleFile(full));
      if (!isRule) {
        await fs.rm(full, { force: true });
        continue;
      }
      ruleFiles += 1;
      const text = await fs.readFile(full, 'utf8');
      ruleCount += (text.match(/^\s*-\s*id\s*:/gm) ?? []).length;
      kept = true;
    }
    return kept;
  };
  await walk(root, 0);
  return { ruleFiles, ruleCount };
}

async function performInstall(def: OpengrepRulePackDef): Promise<OpengrepPackState> {
  const root = rulesRootDir();
  await fs.mkdir(root, { recursive: true });
  const finalDir = rulePackDir(def.id);
  const tmp = path.join(root, `.tmp-${def.id}-${process.pid}-${Date.now()}`);
  const old = path.join(root, `.old-${def.id}-${Date.now()}`);
  try {
    await fetchPackCommit(def.repo, def.commit, tmp);
    const counts = await prunePackTree(tmp, def.prune);
    if (counts.ruleFiles === 0) {
      throw new RulePackError(`pack ${def.id} contained no rule files after pruning`);
    }
    // Swap: move any previous install aside, then the new tree into place.
    try {
      await fs.rename(finalDir, old);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fs.rename(tmp, finalDir);
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
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// Install (or re-install at the pinned commit) one pack. Single-flight per
// pack; a second call while running joins the first.
export function installRulePack(packId: string): Promise<OpengrepPackState> {
  const def = findRulePackDef(packId);
  if (!def) return Promise.reject(new RulePackError(`unknown rule pack: ${packId}`));
  const running = inFlight.get(packId);
  if (running) return running;
  const job: RulePackJob = { status: 'running', packId, startedAt: Date.now() };
  jobs.set(packId, job);
  const p = performInstall(def)
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
      inFlight.delete(packId);
    });
  inFlight.set(packId, p);
  return p;
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
// deletes under the rules root Lattice owns.
export async function removeRulePack(packId: string): Promise<void> {
  const def = findRulePackDef(packId);
  if (!def) throw new RulePackError(`unknown rule pack: ${packId}`);
  await fs.rm(rulePackDir(packId), { recursive: true, force: true });
  await updateOpengrepState((s) => {
    const packs = { ...s.packs };
    delete packs[packId];
    return { ...s, packs };
  });
}
