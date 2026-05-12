import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT_DIR_NAME } from './tasks.js';
import { canonicalProjectPath } from './projectPath.js';

export type StartupTerminal = {
  id: string;
  label: string;
  command: string;
};

export type UserSettings = {
  sidebarWidth?: number;
  harness?: 'claude' | 'pi' | 'codex' | 'interleave';
  startupTerminals?: StartupTerminal[];
  // Per-step collapse state for the workflow editor, keyed by step id.
  // Only collapsed=true entries are persisted to keep the file tidy.
  workflowStepsCollapsed?: Record<string, boolean>;
  // Per-environment override of the auto-injected "you're in a fresh
  // worktree, don't reinstall deps unless the task needs it" note that
  // Lattice prepends to LATTICE_TASK.md / MERGE_INSTRUCTIONS.md when it
  // detects a package-manager environment (see worktree/envDetect.ts).
  // Key = env id ('node' | 'python' | 'rust' | ...). An empty-string value
  // suppresses the note for that env entirely; a key being absent means
  // "use the built-in default".
  worktreeEnvNotes?: Record<string, string>;
};

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
  const current = await getUserSettings(key);
  const updated = { ...current, ...partial };
  const dir = path.join(key, PROJECT_DIR_NAME);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsFile(key), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}
