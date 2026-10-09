// Builds the per-project payload for the settings dialog's template editor:
// each template's default, the user's current (override-or-default) text, and
// its token docs. Read-only — never mutates anything.

import { canonicalProjectPath } from '../projectPath.js';
import { getUserSettings } from '../userSettings.js';
import {
  INSTRUCTION_TEMPLATE_CATALOG,
  type InstructionTemplateEditorEntry,
} from './defs.js';

export type { InstructionTemplateEditorEntry } from './defs.js';

export async function buildInstructionTemplateEditorData(
  project: string,
): Promise<InstructionTemplateEditorEntry[]> {
  const repoRoot = canonicalProjectPath(project);
  let overrides: Record<string, string> = {};
  try {
    const settings = await getUserSettings(repoRoot);
    overrides = settings.instructionTemplateOverrides ?? {};
  } catch {
    /* no overrides — fall back to defaults */
  }
  return INSTRUCTION_TEMPLATE_CATALOG.map((def) => {
    const override = overrides[def.id];
    // Same test as resolve.ts: a whitespace-only override is ignored at spawn,
    // so the editor must show the default for it too, not a blank box.
    const currentTemplate =
      typeof override === 'string' && override.trim().length > 0
        ? override
        : def.defaultTemplate;
    return {
      id: def.id,
      title: def.title,
      filename: def.filename,
      description: def.description,
      defaultTemplate: def.defaultTemplate,
      currentTemplate,
      tokens: def.tokens,
    };
  });
}
