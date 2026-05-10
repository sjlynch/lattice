// Pre-merge-run insurance: a `git bundle` snapshot of the entire object
// graph + all refs, written to `~/.lattice/git-backups/<projectHash>/`.
//
// This does NOT prevent `.git` damage — the layered guards (worktrees out
// of the project tree, the projectGit capability whitelist, the run
// circuit-breaker) do that. It's the "even if all of that is wrong"
// fallback: a bundle captures local-only branches and commits that a fresh
// `origin` clone wouldn't have, so recovery becomes
//
//     git init && git fetch <bundle> && git reset --hard <ref>
//
// instead of "re-clone from origin and lose whatever wasn't pushed". The
// file is compact (deduplicated objects, no working tree) and we keep only
// the most recent few per project.

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { projectGit } from './projectGit.js';
import { projectHash } from '../projectPath.js';

const BACKUPS_BASE = path.join(os.homedir(), '.lattice', 'git-backups');
// How many bundles to keep per project. A merge run produces one; this is
// "the last N runs' worth of pre-state".
const KEEP_PER_PROJECT = 5;
// `git bundle create --all` on a large repo can take a few seconds — cap it
// so a pathological case doesn't stall the start of a merge run forever.
const BUNDLE_TIMEOUT_MS = 60_000;

function projectBackupsDir(repoRoot: string): string {
  return path.join(BACKUPS_BASE, projectHash(repoRoot));
}

// Create a `--all` bundle of `repoRoot` and prune old ones. Best-effort:
// throws are the caller's to swallow (a failed backup must never block a
// merge run). Returns the bundle path on success, null if nothing was
// written.
export async function backupProjectGitBundle(repoRoot: string): Promise<string | null> {
  const dir = projectBackupsDir(repoRoot);
  await fs.mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bundlePath = path.join(dir, `${ts}.bundle`);
  // `git bundle create <file> --all` packs every ref (branches, tags,
  // remotes, HEAD) and their reachable objects. Read-only w.r.t. the repo.
  const r = await projectGit(repoRoot, ['bundle', 'create', bundlePath, '--all'], {
    timeoutMs: BUNDLE_TIMEOUT_MS,
  });
  if (r.code !== 0) {
    // Clean up a partial/empty file so it doesn't masquerade as a backup.
    await fs.rm(bundlePath, { force: true }).catch(() => undefined);
    throw new Error(
      `git bundle create failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim() || 'unknown'}`,
    );
  }
  await pruneOldBundles(dir);
  return bundlePath;
}

async function pruneOldBundles(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.bundle'));
  } catch {
    return;
  }
  if (entries.length <= KEEP_PER_PROJECT) return;
  // Names are ISO timestamps with `:`/`.` replaced by `-`, so lexical sort
  // is chronological. Keep the newest KEEP_PER_PROJECT, delete the rest.
  entries.sort();
  const toDelete = entries.slice(0, entries.length - KEEP_PER_PROJECT);
  for (const name of toDelete) {
    await fs.rm(path.join(dir, name), { force: true }).catch(() => undefined);
  }
}
