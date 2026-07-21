// Public barrel for the per-harness system-prompt override subsystem
// (Settings → Agent prompts → "Harness system prompts"). Consumers import from
// `./harnessSystemPrompts.js`; the implementation lives under
// `harnessSystemPrompts/`. See its CLAUDE.md.

export {
  HARNESS_SYSTEM_PROMPT_CATALOG,
  getHarnessSystemPromptDef,
  isHarnessSystemPromptKind,
  type HarnessSystemPromptKind,
  type HarnessSystemPromptOverride,
  type HarnessSystemPromptDef,
} from './harnessSystemPrompts/defs.js';
export { resolveHarnessSystemPrompt } from './harnessSystemPrompts/resolve.js';
export {
  buildHarnessSystemPromptEditorData,
  type HarnessSystemPromptEditorEntry,
} from './harnessSystemPrompts/editorData.js';
export {
  prepareClaudeSystemPrompt,
  prepareCodexSystemPrompt,
  preparePiSystemPrompt,
  type ClaudeSystemPromptFiles,
} from './harnessSystemPrompts/inject.js';
