// Types for GET /api/instruction-templates — the editable agent instruction
// templates surfaced in Settings → Agent prompts. The backend's own types
// (backend/src/instructionTemplates/defs.ts, re-exported through
// backend/src/shared/wireTypes.ts). `defaultTemplate` is Lattice's built-in;
// `currentTemplate` is the project's override-or-default. Edits are saved as
// `UserSettings.instructionTemplateOverrides[id]`.
export type {
  InstructionTemplateEditorEntry as InstructionTemplate,
  InstructionTemplateToken,
} from '../../../../backend/src/shared/wireTypes';
