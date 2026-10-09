// Builds the per-project payload for the settings dialog's harness
// system-prompt editor: for each harness, its read-only default overview plus
// the project's current Append / Replace override text. Read-only — never
// mutates anything. Backs GET /api/harness-system-prompts.

import { canonicalProjectPath } from '../projectPath.js';
import { getUserSettings } from '../userSettings.js';
import {
  HARNESS_SYSTEM_PROMPT_CATALOG,
  type HarnessSystemPromptEditorEntry,
} from './defs.js';

export type { HarnessSystemPromptEditorEntry } from './defs.js';

export async function buildHarnessSystemPromptEditorData(
  project: string,
): Promise<HarnessSystemPromptEditorEntry[]> {
  const repoRoot = canonicalProjectPath(project);
  let overrides: Record<string, { append?: string; replace?: string }> = {};
  try {
    const settings = await getUserSettings(repoRoot);
    overrides = settings.harnessSystemPrompts ?? {};
  } catch {
    /* no overrides — fall back to defaults */
  }
  return HARNESS_SYSTEM_PROMPT_CATALOG.map((def) => {
    const saved = overrides[def.harness];
    return {
      ...def,
      currentAppend: typeof saved?.append === 'string' ? saved.append : '',
      currentReplace: typeof saved?.replace === 'string' ? saved.replace : '',
    };
  });
}
