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
