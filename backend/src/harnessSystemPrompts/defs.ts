// The catalog of per-harness system-prompt overrides: for each agent harness
// (Claude / Codex / Pi), the read-only "what is the built-in system prompt"
// overview Lattice shows in Settings → Agent prompts, plus the per-field docs
// for the two editable overrides (Append / Replace). This module is a LEAF
// (it imports nothing from the resolver or the spawn plumbing) so both the
// editor-data builder and the resolver can import from here without a cycle.
//
// Unlike the instruction TEMPLATES (LATTICE_TASK.md etc., which Lattice fully
// owns and can show verbatim), a harness's *system prompt* is the harness's own.
// Codex and Pi are open-source, so their defaults are public and summarized
// here with a source link; Claude Code's is proprietary and unpublished, so we
// say so plainly rather than displaying an inaccurate copy. All three CLIs let
// you either APPEND to or fully REPLACE their built-in prompt — Lattice injects
// whatever you enter at every spawn of that harness in this project.

export type HarnessSystemPromptKind = 'claude' | 'codex' | 'pi';

// A per-harness system-prompt override: text to append and/or text that fully
// replaces the built-in prompt. Both are independent — a blank field means
// "don't touch that side". Stored on `UserSettings.harnessSystemPrompts`.
export type HarnessSystemPromptOverride = {
  append?: string;
  replace?: string;
};

export type HarnessSystemPromptDef = {
  harness: HarnessSystemPromptKind;
  title: string;
  // One-paragraph description of what the harness's built-in system prompt is
  // and how it's composed (shown above the read-only default block).
  overview: string;
  // The best available representation of the built-in default. For Codex/Pi an
  // accurate persona + composition outline sourced from the open-source prompt;
  // for Claude an honest "not available" explanation (its prompt is private).
  defaultPrompt: string;
  // True when `defaultPrompt` reflects the harness's actual (open-source)
  // prompt text/structure; false when it's only an explanation because the
  // real default can't be shown (Claude).
  defaultViewable: boolean;
  // Per-field editor docs.
  appendDescription: string;
  replaceDescription: string;
  // Shown under the Replace field — the per-harness caveat for fully replacing
  // the built-in prompt (all three vendors discourage it to varying degrees).
  replaceWarning?: string;
  // Where the authoritative default lives (a link the user can open).
  sourceUrl?: string;
  sourceLabel?: string;
};

const CLAUDE_DEFAULT_PROMPT = `Not shown — Claude Code's built-in system prompt is proprietary and is NOT
published by Anthropic. No \`claude\` command prints it, so Lattice can't
display the real text without guessing.

For reference, it's assembled at runtime from Claude Code's core instructions,
its built-in tool definitions, response-style / coding guidelines, and
per-machine context (working directory, git status). Your project's CLAUDE.md
files layer on top of it as memory — they don't replace it.

You can still Append to or fully Replace it below; you just can't view the
built-in text here. Community projects reverse-engineer and track it if you
want an approximation (e.g. github.com/Piebald-AI/claude-code-system-prompts —
unofficial, not from Anthropic).`;

const CODEX_DEFAULT_PROMPT = `Outline of Codex's open-source base instructions (the live prompt is assembled
per model — a model-specific template when one exists, otherwise this generic
base — so the exact text depends on your Codex version and model).

It opens with, verbatim:

  "You are a coding agent running in the Codex CLI, a terminal-based coding
   assistant. Codex CLI is an open source project led by OpenAI. You are
   expected to be precise, safe, and helpful."

…then covers, in sections: Personality · How you work · the AGENTS.md spec
(project files that stack on top of these base instructions) · Planning · Task
execution · Testing & validation · Ambition vs. precision · Sandboxing &
approvals · Sharing progress updates · Presenting your final work · Tool
guidelines (apply_patch, shell/rg, plan updates).

See the source link below for the full, current text.`;

const PI_DEFAULT_PROMPT = `Pi assembles its system prompt at runtime from a fixed persona plus dynamic
sections, so there is no single canonical string — but the persona opening is
stable and reads, verbatim:

  "You are an expert coding assistant operating inside pi, a coding agent
   harness. You help users by reading files, executing commands, editing code,
   and writing new files."

buildSystemPrompt() then appends, in order: Available tools (from the enabled
tool set) · Guidelines (e.g. "Be concise in your responses", "Show file paths
clearly") · Pi documentation references · Project context (your AGENTS.md /
CLAUDE.md) · Skills · the Current working directory. Only the persona +
guideline strings are static; the rest is computed per session.

See the source link below for the full assembly.`;

export const HARNESS_SYSTEM_PROMPT_CATALOG: HarnessSystemPromptDef[] = [
  {
    harness: 'claude',
    title: 'Claude Code',
    overview:
      "Claude Code's built-in system prompt is proprietary — Anthropic doesn't publish it and no CLI command prints it, so it can't be shown here. You can still fully replace or append to it; you just can't view the built-in text.",
    defaultPrompt: CLAUDE_DEFAULT_PROMPT,
    defaultViewable: false,
    appendDescription:
      'Appended to Claude Code’s built-in system prompt for every Claude session Lattice spawns in this project (via `claude --append-system-prompt-file`). Safe — Claude keeps all of its built-in behavior and just gains your extra rules.',
    replaceDescription:
      'REPLACES Claude Code’s entire built-in system prompt with your text (via `claude --system-prompt-file`).',
    replaceWarning:
      'Replacing removes Claude Code’s built-in tool-use, coding, and safety guidance — the agent can misbehave. Tool definitions still load, but the behavioral instructions are gone. Prefer Append unless you really mean to take full control.',
    sourceUrl: 'https://code.claude.com/docs/en/cli-reference',
    sourceLabel: 'Claude Code CLI reference',
  },
  {
    harness: 'codex',
    title: 'Codex CLI',
    overview:
      "Codex is open-source, so its default base instructions are public (summarized below). The live prompt is assembled per model, so the exact text depends on your Codex version and model. AGENTS.md files stack on top as project context.",
    defaultPrompt: CODEX_DEFAULT_PROMPT,
    defaultViewable: true,
    appendDescription:
      'Added as Codex `developer_instructions` (a developer-role message layered on top of the base instructions) for every Codex session Lattice spawns in this project. Additive and safe — the recommended way to customize Codex.',
    replaceDescription:
      'REPLACES Codex’s built-in base instructions via `model_instructions_file` (a per-invocation `-c` override; needs a recent Codex build).',
    replaceWarning:
      'OpenAI STRONGLY DISCOURAGES replacing the base instructions: it degrades model performance, and GPT-5-class models may reject a fully-custom prompt with a 400 error. Prefer Append.',
    sourceUrl:
      'https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md',
    sourceLabel: 'Codex base instructions (default.md)',
  },
  {
    harness: 'pi',
    title: 'Pi',
    overview:
      'Pi is open-source; it assembles its system prompt at runtime from a fixed persona plus dynamic sections (tool list, guidelines, Pi docs, your project context, skills, cwd), so there is no single canonical string. The persona opening is stable.',
    defaultPrompt: PI_DEFAULT_PROMPT,
    defaultViewable: true,
    appendDescription:
      'Appended to Pi’s assembled system prompt for every Pi session Lattice spawns in this project, via a Lattice-installed Pi extension (the `before_agent_start` hook).',
    replaceDescription:
      'REPLACES Pi’s persona/base prompt via the same Lattice-installed Pi extension (equivalent to `pi --system-prompt`).',
    replaceWarning:
      'Replacing drops Pi’s built-in tool/guideline sections (matching `pi --system-prompt`). Prefer Append. Applied through a Lattice Pi extension, so it needs a Pi build that supports the `before_agent_start` hook.',
    sourceUrl:
      'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts',
    sourceLabel: 'Pi system-prompt.ts',
  },
];

export function getHarnessSystemPromptDef(
  harness: string,
): HarnessSystemPromptDef | undefined {
  return HARNESS_SYSTEM_PROMPT_CATALOG.find((d) => d.harness === harness);
}

// Narrowing helper for untrusted strings (request bodies, settings keys).
export function isHarnessSystemPromptKind(
  value: unknown,
): value is HarnessSystemPromptKind {
  return value === 'claude' || value === 'codex' || value === 'pi';
}
