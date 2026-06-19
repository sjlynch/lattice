import { applyTemplate } from '../instructionTemplates/apply.js';
import { DEFAULT_PUSH_TEMPLATE } from '../instructionTemplates/defs.js';

export function renderPushInstructions(
  projectPath: string,
  template: string = DEFAULT_PUSH_TEMPLATE,
): string {
  return applyTemplate(template, { project_path: projectPath });
}
