// Types for GET /api/harness-system-prompts — the per-harness system-prompt
// editor data surfaced in Settings → Agent prompts ("Harness system prompts").
// See backend harnessSystemPrompts/.

export type HarnessSystemPromptKind = 'claude' | 'codex' | 'pi';

// One harness's editor entry: a read-only description of its built-in default
// system prompt plus the project's current Append / Replace override text.
// Edits are saved as `UserSettings.harnessSystemPrompts[harness]`.
export type HarnessSystemPromptEntry = {
  harness: HarnessSystemPromptKind;
  title: string;
  // One-paragraph description of the built-in prompt (shown above the default).
  overview: string;
  // Best available representation of the built-in default (actual text/outline
  // for Codex/Pi; an honest "not available" note for Claude).
  defaultPrompt: string;
  // True when `defaultPrompt` reflects the real (open-source) prompt; false when
  // it's only an explanation because the default can't be shown (Claude).
  defaultViewable: boolean;
  appendDescription: string;
  replaceDescription: string;
  // Per-harness caveat for fully replacing the built-in prompt.
  replaceWarning?: string;
  sourceUrl?: string;
  sourceLabel?: string;
  // The project's saved override for each side, or '' when unset.
  currentAppend: string;
  currentReplace: string;
};
