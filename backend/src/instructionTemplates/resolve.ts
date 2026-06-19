// Resolves the template a spawn path should use: the project's saved override
// if present and non-empty, otherwise the built-in default. Spawn callers call
// this (async) and pass the result into the synchronous render functions.

import { getUserSettings } from '../userSettings.js';
import { getInstructionTemplateDef, type InstructionTemplateId } from './defs.js';

export async function resolveInstructionTemplate(
  projectPath: string,
  id: InstructionTemplateId,
): Promise<string> {
  const fallback = getInstructionTemplateDef(id)?.defaultTemplate ?? '';
  try {
    const settings = await getUserSettings(projectPath);
    const override = settings.instructionTemplateOverrides?.[id];
    // Only honor a non-empty override — a blank one would wipe the instruction
    // file, so fall back to the default in that case (a safety net against an
    // accidentally-cleared editor box).
    if (typeof override === 'string' && override.trim().length > 0) {
      return override;
    }
  } catch {
    /* fall through to the default */
  }
  return fallback;
}
