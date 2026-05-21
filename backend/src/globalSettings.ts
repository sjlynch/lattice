// Machine-global settings — distinct from per-project userSettings.ts.
//
// Stored at ~/.lattice/globalSettings.json. Currently just the spawn queue's
// softCap (`maxConcurrentAgents`): one backend, one terminal-server, one
// machine's RAM/CPU, so concurrency is a machine fact, not a per-project one.

import fs from 'node:fs/promises';
import path from 'node:path';
import { latticeHomeDir } from './projectPath.js';

export type GlobalSettings = {
  // Max agents Lattice runs concurrently — the spawn queue's softCap. Spawns
  // above this are deferred in the queue, never dropped.
  maxConcurrentAgents: number;
};

// Bounds for maxConcurrentAgents. The upper bound stays well under the
// terminal-server hard cap (200) so the priority/interactive reserve band
// and un-queued manual terminals still have room.
export const MIN_MAX_CONCURRENT_AGENTS = 1;
export const MAX_MAX_CONCURRENT_AGENTS = 150;

function envDefaultMaxAgents(): number {
  const n = Number(process.env.LATTICE_MAX_CONCURRENT_AGENTS);
  return Number.isInteger(n) && n > 0 ? n : 24;
}

export const GLOBAL_SETTINGS_DEFAULTS: GlobalSettings = {
  maxConcurrentAgents: clampMaxConcurrentAgents(envDefaultMaxAgents()),
};

export function clampMaxConcurrentAgents(n: number): number {
  return Math.min(
    MAX_MAX_CONCURRENT_AGENTS,
    Math.max(MIN_MAX_CONCURRENT_AGENTS, Math.floor(n)),
  );
}

function globalSettingsFile(): string {
  return path.join(latticeHomeDir(), 'globalSettings.json');
}

function sanitize(raw: Partial<GlobalSettings>): Partial<GlobalSettings> {
  const out: Partial<GlobalSettings> = {};
  if (
    typeof raw.maxConcurrentAgents === 'number' &&
    Number.isFinite(raw.maxConcurrentAgents) &&
    raw.maxConcurrentAgents > 0
  ) {
    out.maxConcurrentAgents = clampMaxConcurrentAgents(raw.maxConcurrentAgents);
  }
  return out;
}

// Read global settings, falling back to defaults for a missing/corrupt file.
export async function getGlobalSettings(): Promise<GlobalSettings> {
  try {
    const raw = await fs.readFile(globalSettingsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GlobalSettings>;
    return { ...GLOBAL_SETTINGS_DEFAULTS, ...sanitize(parsed) };
  } catch {
    return { ...GLOBAL_SETTINGS_DEFAULTS };
  }
}

// Merge-update and persist global settings; returns the full updated record.
export async function updateGlobalSettings(
  patch: Partial<GlobalSettings>,
): Promise<GlobalSettings> {
  const current = await getGlobalSettings();
  const updated: GlobalSettings = { ...current, ...sanitize(patch) };
  await fs.mkdir(latticeHomeDir(), { recursive: true });
  await fs.writeFile(
    globalSettingsFile(),
    JSON.stringify(updated, null, 2),
    'utf8',
  );
  return updated;
}
