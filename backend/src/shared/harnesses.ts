// The agent-harness vocabulary and the Pi model pattern, shared VERBATIM by the
// backend and the frontend (see ./CLAUDE.md for the import rules). Before this
// file both packages carried their own copy, kept "in lockstep" by comments.

export type AgentHarness = 'claude' | 'pi' | 'codex';

export const ALL_AGENT_HARNESSES: readonly AgentHarness[] = [
  'claude',
  'pi',
  'codex',
] as const;

export function isAgentHarness(value: unknown): value is AgentHarness {
  return value === 'claude' || value === 'pi' || value === 'codex';
}

export function normalizeAgentHarness(value: unknown): AgentHarness {
  return isAgentHarness(value) ? value : 'claude';
}

// A Pi model selector: `provider/model[:thinking]`, safe characters only — the
// shell-injection guard before a model reaches `pi --model "<x>"`. The MODEL
// half may itself contain slashes: an OpenAI-compatible server often reports a
// HuggingFace repo id (`my-vllm/meta-llama/Llama-3.1-8B-Instruct`). A value
// this rejects has its `--model` flag dropped, so Pi runs its default model.
export const PI_MODEL_PATTERN_RE =
  /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+(:[A-Za-z0-9_.-]+)?$/;

export function isPiModelPattern(value: string): boolean {
  return PI_MODEL_PATTERN_RE.test(value);
}

// Reasoning effort for an agent launch, Claude Code's `--effort` vocabulary.
// Codex gets it as `-c model_reasoning_effort=<x>` (no `max`: it maps to
// `xhigh`), Pi as `--thinking <x>`. Absent = the harness's own default.
export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const ALL_AGENT_EFFORTS: readonly AgentEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export function normalizeAgentEffort(value: unknown): AgentEffort | undefined {
  return typeof value === 'string' && (ALL_AGENT_EFFORTS as readonly string[]).includes(value)
    ? (value as AgentEffort)
    : undefined;
}

// A Claude / Codex model: an alias (`opus`, `sonnet`, `fable`) or a full id
// (`claude-opus-5-5[1m]`, `gpt-5.5-codex`). Safe characters only — it is
// interpolated into a shell command line; anything else is dropped (the
// harness runs its default model). Pi models are `piModel`, never this.
export const AGENT_MODEL_PATTERN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/[\]-]{0,99}$/;

export function normalizeAgentModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return AGENT_MODEL_PATTERN_RE.test(trimmed) ? trimmed : undefined;
}
