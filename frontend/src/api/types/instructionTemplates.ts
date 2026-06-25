// Types for GET /api/instruction-templates — the editable agent instruction
// templates surfaced in Settings → Agent prompts. See backend
// instructionTemplates/.

// One token (`{{name}}`) a template can interpolate, with a human-readable
// note shown in the editor's legend.
export type InstructionTemplateToken = {
  name: string;
  description: string;
};

// An editable instruction template Lattice writes for a spawned agent. Backs
// the settings dialog's "Agent prompts" tab. `defaultTemplate` is Lattice's
// built-in; `currentTemplate` is the project's override-or-default. Edits are
// saved as `UserSettings.instructionTemplateOverrides[id]`. See backend
// instructionTemplates/.
export type InstructionTemplate = {
  id: string;
  title: string;
  filename: string;
  description: string;
  defaultTemplate: string;
  currentTemplate: string;
  tokens: InstructionTemplateToken[];
};
