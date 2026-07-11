// Shared shell command assembly for agent harnesses.
//
// Call sites keep the intent-specific prompt text local, while this module
// owns the repeated harness syntax: Claude's permission bypass, Pi's safe
// --model flag, Codex's --yolo permission bypass, and shell quoting.

import path from 'node:path';
import type { AgentHarness } from './harnesses.js';

// A Pi model selector is a `provider/model` pattern, optionally with a
// `:thinking`-style suffix (e.g. `qwen-local/qwen`, `openai-codex/gpt-5.5`).
// Restrict to the character set those patterns actually use so a value coming
// from settings / request bodies can be interpolated into a shell command line
// without opening an injection surface. Anything else is rejected (→ Pi's own
// default model is used).
const PI_MODEL_PATTERN_RE =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(:[A-Za-z0-9_.-]+)?$/;

// Coerce an untrusted value to a safe Pi model pattern, or `undefined`.
export function normalizePiModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return PI_MODEL_PATTERN_RE.test(trimmed) ? trimmed : undefined;
}

// The single place that turns a resolved Pi model into a `--model` flag (and
// the only place that quotes it). Empty string when no/invalid model so the
// session falls back to Pi's configured default.
export function buildPiModelFlag(piModel?: string): string {
  const model = normalizePiModel(piModel);
  return model ? ` --model "${model}"` : '';
}

export function promptFileName(instructionsFile: string): string {
  return path.basename(instructionsFile);
}

function shellDoubleQuoted(value: string): string {
  return `"${value.replace(/["\\$`]/g, '\\$&')}"`;
}

export function buildAgentCommand(args: {
  harness: AgentHarness;
  prompt: string;
  piModel?: string;
  // Whether to launch Codex with `--yolo` (its analogue of Claude's
  // `--dangerously-skip-permissions`: run tool calls without prompting). ON by
  // default — only an explicit `false` drops the flag. Ignored for
  // claude/pi. Resolved per-project from UserSettings.codexYolo at the spawn
  // sites (isCodexYoloEnabled); the default here keeps un-threaded call sites
  // matching the default-on setting.
  codexYolo?: boolean;
}): string {
  const quotedPrompt = shellDoubleQuoted(args.prompt);
  if (args.harness === 'claude') {
    return `claude --dangerously-skip-permissions ${quotedPrompt}`;
  }
  if (args.harness === 'pi') {
    return `pi${buildPiModelFlag(args.piModel)} ${quotedPrompt}`;
  }
  const yolo = args.codexYolo === false ? '' : ' --yolo';
  return `codex${yolo} ${quotedPrompt}`;
}
