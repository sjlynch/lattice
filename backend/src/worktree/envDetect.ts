// Detects which package-manager / dependency-cache environments a project
// uses, so Lattice can drop a short "you're in a throwaway worktree — the
// deps dir isn't checked out here, don't reinstall unless the task needs
// it" note into the instructions files it writes (LATTICE_TASK.md,
// MERGE_INSTRUCTIONS.md, …). Without that note, the in-worktree agent
// tends to burn reasoning tokens (and wall-clock) deciding whether to run
// `npm install` and usually does, even for tasks that never touch the
// build/test path.
//
// Detection is deliberately conservative and root-only (no recursive
// workspace scan — that'd slow down every `/run`): an environment is
// reported only when (1) one of its marker files exists at the repo root,
// (2) its heavy dir actually exists in the main checkout (so we never nag
// about something the user themselves never installed), and (3) that heavy
// dir isn't tracked by git (so it genuinely won't be in a fresh worktree).
//
// The note text is overridable per environment via UserSettings
// (`worktreeEnvNotes`) — surfaced in the Lattice settings dialog so users
// can discover and tweak (or blank out) what gets injected.

import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from './exec.js';
import { getUserSettings } from '../userSettings.js';
import {
  DETECTORS,
  LOCKFILE_NAMES,
  hasDetectorMarker,
  type DetectedEnv,
} from './envDetect/detectors.js';
import { defaultEnvNote, type EnvNoteInfo } from './envDetect/notes.js';

export type { DetectedEnv, EnvKind } from './envDetect/detectors.js';
export { defaultEnvNote, renderEnvNotesBlock } from './envDetect/notes.js';
export type { EnvNoteInfo } from './envDetect/notes.js';

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// True when nothing under `relDir` is tracked by git in `repoRoot` — i.e.
// `git worktree add` won't materialize it (worktrees get tracked files
// only), so the "this dir isn't here" note is accurate. Tolerant: any git
// failure (shouldn't happen — caller already knows it's a repo) is treated
// as "not tracked" since that's overwhelmingly the real-world case.
async function isUntrackedDir(repoRoot: string, relDir: string): Promise<boolean> {
  try {
    const r = await exec(
      'git',
      ['ls-files', '--error-unmatch', '--', relDir],
      repoRoot,
      { timeoutMs: 5_000 },
    );
    return r.code !== 0;
  } catch {
    return true;
  }
}

export async function detectProjectEnvironments(repoRoot: string): Promise<DetectedEnv[]> {
  let rootEntries: string[] = [];
  try {
    rootEntries = await fs.readdir(repoRoot);
  } catch {
    return [];
  }
  const rootSet = new Set(rootEntries);
  const lockfilesPresent = new Set(LOCKFILE_NAMES.filter((n) => rootSet.has(n)));

  const detected: DetectedEnv[] = [];
  for (const det of DETECTORS) {
    if (!hasDetectorMarker(det, rootEntries, rootSet)) continue;

    let heavyDir: string | null = null;
    for (const cand of det.heavyDirCandidates) {
      if (await isDir(path.join(repoRoot, cand))) {
        heavyDir = cand;
        break;
      }
    }
    if (!heavyDir) continue;
    if (!(await isUntrackedDir(repoRoot, heavyDir))) continue;

    const m = await det.resolveManager(repoRoot, lockfilesPresent);
    detected.push({
      id: det.id,
      label: det.label,
      heavyDir,
      manager: m.manager,
      installCmd: m.installCmd,
    });
  }
  return detected;
}

// Resolve the per-env notes against a project's saved settings. Returns one
// entry per detected env (including ones the user suppressed — `effectiveNote
// === ''` — so the settings UI can show that state).
export async function describeProjectEnvs(
  repoRoot: string,
  settings: { worktreeEnvNotes?: Record<string, string> } | undefined,
): Promise<EnvNoteInfo[]> {
  const envs = await detectProjectEnvironments(repoRoot);
  const overrides = settings?.worktreeEnvNotes ?? {};
  return envs.map((env) => {
    const defaultNote = defaultEnvNote(env);
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, env.id);
    const effectiveNote = hasOverride ? String(overrides[env.id] ?? '') : defaultNote;
    return { ...env, defaultNote, effectiveNote };
  });
}

// The notes to actually inject into an instructions file written for a
// worktree of `repoRoot`. Loads the project's UserSettings itself so the
// many instruction-writer call sites don't each have to thread it through.
// Resilient: any failure yields an empty list (no note is strictly better
// than a wrong one).
export async function resolveEnvNotesForInstructions(repoRoot: string): Promise<string[]> {
  try {
    const settings = await getUserSettings(repoRoot);
    const described = await describeProjectEnvs(repoRoot, settings);
    return described.map((e) => e.effectiveNote.trim()).filter((s) => s.length > 0);
  } catch (err) {
    console.warn(`[envDetect] resolveEnvNotesForInstructions(${repoRoot}) failed:`, err);
    return [];
  }
}
