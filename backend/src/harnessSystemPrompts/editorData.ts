// Builds the per-project payload for the settings dialog's harness
// system-prompt editor: for each harness, its read-only default overview plus
// the project's current Append / Replace override text. Read-only — never
// mutates anything. Backs GET /api/harness-system-prompts.

import { canonicalProjectPath } from '../projectPath.js';
import { getUserSettings } from '../userSettings.js';
import {
  HARNESS_SYSTEM_PROMPT_CATALOG,
  type HarnessSystemPromptDef,
} from './defs.js';

export type HarnessSystemPromptEditorEntry = HarnessSystemPromptDef & {
  // The project's saved override for each side, or '' when unset. Seeds the
  // editor textareas; a blank value falls back to the harness default.
  currentAppend: string;
  currentReplace: string;
};

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
