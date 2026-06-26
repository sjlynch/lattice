import fs from 'node:fs/promises';
import path from 'node:path';
// Import the constant from the leaf paths module, NOT from `../tasks.js` (which
// re-exports the whole task cache). This keeps userSettings — and therefore the
// MCP registry / detached terminal-server that now read it at spawn time — free
// of the heavy taskCache import chain.
import { PROJECT_DIR_NAME } from '../taskCache/paths.js';
import { canonicalProjectPath } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
import type { UserSettings } from './types.js';

function settingsFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR_NAME, 'userSettings.json');
}

export async function getUserSettings(projectPath: string): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  try {
    const raw = await fs.readFile(settingsFile(key), 'utf8');
    return JSON.parse(raw) as UserSettings;
  } catch {
    return {};
  }
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  // Serialize per-project so concurrent patches with disjoint fields don't
  // each read the same base and clobber one another's write (see
  // serializeWrites.ts). The read happens INSIDE the critical section so each
  // patch sees the prior write's result.
  return runExclusive(`userSettings:${key}`, async () => {
    const current = await getUserSettings(key);
    const updated = { ...current, ...partial };
    const dir = path.join(key, PROJECT_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(settingsFile(key), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  });
}
