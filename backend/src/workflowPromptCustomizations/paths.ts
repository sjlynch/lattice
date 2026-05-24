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

// CJS helper invoked by the Claude Stop hook as a fail-soft backstop —
// reads `CUSTOMIZED_PROMPT.md` and POSTs it as JSON, falling back to a
// `?error=` POST if the file is missing so the request leaves `running`.
// See backstopScripts.ts.
export function backstopScriptFile(cwd: string): string {
  return path.join(cwd, 'lattice-customization-backstop.cjs');
}

export function customizedPromptFile(cwd: string): string {
  return path.join(cwd, 'CUSTOMIZED_PROMPT.md');
}
