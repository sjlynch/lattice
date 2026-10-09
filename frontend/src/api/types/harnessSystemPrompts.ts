// Types for GET /api/harness-system-prompts — the per-harness system-prompt
// editor data surfaced in Settings → Agent prompts ("Harness system prompts").
// The backend's own types (backend/src/harnessSystemPrompts/defs.ts,
// re-exported through backend/src/shared/wireTypes.ts). Edits are saved as
// `UserSettings.harnessSystemPrompts[harness]`.
export type {
  HarnessSystemPromptEditorEntry as HarnessSystemPromptEntry,
  HarnessSystemPromptKind,
} from '../../../../backend/src/shared/wireTypes';
