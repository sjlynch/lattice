import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_DIR_NAME } from './tasks.js';

export type UserSettings = {
  sidebarWidth?: number;
  harness?: 'claude' | 'pi' | 'interleave';
};

function settingsFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR_NAME, 'userSettings.json');
}

export async function getUserSettings(projectPath: string): Promise<UserSettings> {
  try {
    const raw = await fs.readFile(settingsFile(projectPath), 'utf8');
    return JSON.parse(raw) as UserSettings;
  } catch {
    return {};
  }
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  const current = await getUserSettings(projectPath);
  const updated = { ...current, ...partial };
  const dir = path.join(projectPath, PROJECT_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsFile(projectPath), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}
