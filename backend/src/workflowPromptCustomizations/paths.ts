import path from 'node:path';

export function customizationDir(projectPath: string, id: string): string {
  return path.join(projectPath, '.lattice', 'workflow-prompt-customizations', id);
}

export function customizationInstructionsFile(cwd: string): string {
  return path.join(cwd, 'CUSTOMIZE_PROMPT.md');
}

export function submitScriptFile(cwd: string): string {
  return path.join(cwd, 'submit-customized-prompt.cjs');
}

export function submittedPromptFile(cwd: string): string {
  return path.join(cwd, 'CUSTOMIZED_PROMPT.submitted.md');
}
