// "A post-merge hook is owed" — a durable per-project marker.
//
// The hook fires AFTER merges land: at the end of a merge run
// (`mergeRuns/teardown.ts`, only when that run merged something), or after a
// manual / resolver finalize outside a run. Both are in-memory decisions. A
// backend killed between a task landing in QA and the hook firing — a crash,
// or on Lattice's own repo any restart the dev runner could not defer — came
// back with nothing to merge, so the resumed merge run (merged: 0) and the
// workflow Merge step (Ready-to-Merge already empty) both skipped the hook,
// silently. Found by the self-hosting soak.
//
// So a finalize that lands a task in QA while a hook is configured records the
// debt here (`~/.lattice/per-project/<hash>/post-merge-hook-owed.json`, with
// `since` = when), the trigger clears it once it has actually decided (started /
// not configured / a hook already running that started at or after `since`),
// and everything that could have fired the hook also honours
// the marker: merge-run teardown, the workflow Merge step's Phase C, and boot
// recovery (`recovery/owedPostMergeHooks.ts`) for a project with neither.

import fs from 'node:fs/promises';
import path from 'node:path';
import { homeProjectScratchDir } from '../projectPath.js';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { getUserSettings } from '../userSettings.js';

const OWED_FILENAME = 'post-merge-hook-owed.json';

function owedFile(projectPath: string): string {
  return homeProjectScratchDir(projectPath, OWED_FILENAME);
}

// Record the debt — only when a hook would actually run (a prompt is set and
// the master toggle isn't off), so an unconfigured project never carries one.
// Best-effort: a failed write costs only the restart guarantee.
export async function markPostMergeHookOwed(projectPath: string): Promise<void> {
  try {
    const settings = await getUserSettings(projectPath);
    if (!(settings.postMergeHookPrompt ?? '').trim() || settings.postMergeHookEnabled === false) return;
    const file = owedFile(projectPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, JSON.stringify({ since: Date.now() }));
  } catch (err) {
    console.warn(`[post-merge-hook] could not record the owed hook for ${projectPath}:`, err);
  }
}

export async function isPostMergeHookOwed(projectPath: string): Promise<boolean> {
  try {
    await fs.access(owedFile(projectPath));
    return true;
  } catch {
    return false;
  }
}

// When the debt was (last) recorded, or `null` when there is no marker — or a
// legacy / unreadable one, which callers must treat as "not provably covered".
// `markPostMergeHookOwed` rewrites `since` on every merge, so a hook that
// started at or after it was started for every merge the marker stands for.
export async function readPostMergeHookOwedSince(projectPath: string): Promise<number | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(owedFile(projectPath), 'utf8'));
    const since = (parsed as { since?: unknown } | null)?.since;
    return typeof since === 'number' && Number.isFinite(since) ? since : null;
  } catch {
    return null;
  }
}

export async function clearPostMergeHookOwed(projectPath: string): Promise<void> {
  await fs.rm(owedFile(projectPath), { force: true }).catch((err: unknown) => {
    // A marker left behind makes the next gate / boot fire the hook again.
    console.warn(`[post-merge-hook] could not clear the owed-hook marker for ${projectPath}:`, err);
  });
}
