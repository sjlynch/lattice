// Pi THINKING LEVELS for a managed endpoint.
//
// Pi has seven levels — off, minimal, low, medium, high, xhigh, max — but a
// model only gets the top two if it declares a `thinkingLevelMap`. With the map
// omitted, Pi CLAMPS: asking for `xhigh` or `max` silently sends `high`, with no
// error and nothing in the output to say it happened. So a Qwen server that
// genuinely supports xhigh is capped at high unless Lattice writes the map.
//
// The map is tristate per level: a string is the token sent to the provider,
// `null` means unsupported (hidden/clamped away), and a missing key falls back
// to Pi's default mapping. We always write all seven so the result doesn't
// depend on which half of that rule applies.
//
// The levels are DETECTED, never hardcoded: an OpenAI-compatible server that
// validates `reasoning_effort` rejects a bad value with an error that
// enumerates the ones it accepts, so one deliberately-invalid request tells us
// the supported set without generating a single token. See probeThinkingLevels
// in ./probe.ts.

// Pi's levels, in order. `off` is the odd one out: servers usually spell it
// `none` (NInfer, vLLM), so it is matched by alias below.
export const PI_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

// Tokens a server might use for "no thinking", mapped onto Pi's `off`.
const OFF_ALIASES = ['off', 'none'] as const;

// Every token that could appear in a server's enumeration — Pi's levels plus
// the `off` aliases.
const KNOWN_TOKENS: readonly string[] = [
  ...new Set<string>([...PI_THINKING_LEVELS, ...OFF_ALIASES]),
];

// Canonical ordering for any token list we return: weakest first, `off`
// aliases ahead of the rest.
const TOKEN_ORDER: readonly string[] = [...OFF_ALIASES, ...PI_THINKING_LEVELS];

function inTokenOrder(tokens: Iterable<string>): string[] {
  return [...tokens].sort((a, b) => TOKEN_ORDER.indexOf(a) - TOKEN_ORDER.indexOf(b));
}

// Pull the accepted effort tokens out of a server's rejection message, e.g.
// NInfer's "reasoning_effort must be one of none, minimal, low, medium, high,
// xhigh, or max". Matches on word boundaries so `high` inside `xhigh` doesn't
// double-count, and returns them in Pi's level order.
//
// Returns [] when nothing recognizable is present — the caller then leaves the
// model alone rather than guessing, so an unrecognized server keeps today's
// behaviour instead of getting a map built on a misparse.
export function parseAcceptedEffortTokens(message: string): string[] {
  if (!message) return [];
  const found = new Set<string>();
  for (const token of KNOWN_TOKENS) {
    if (new RegExp(`(?<![A-Za-z])${token}(?![A-Za-z])`).test(message)) {
      found.add(token);
    }
  }
  // A message naming only ONE token is far more likely to be prose that happens
  // to contain a level word ("reasoning_effort is not supported") than a real
  // enumeration. Require at least two before trusting it.
  if (found.size < 2) return [];
  return inTokenOrder(found);
}

// Whether a detected token set is worth recording. Everything through `high` is
// already Pi's default behaviour, so a server offering only those needs no map
// — writing one would add config that changes nothing.
export function extendsBeyondStandard(tokens: readonly string[]): boolean {
  return tokens.includes('xhigh') || tokens.includes('max');
}

// Build Pi's `thinkingLevelMap` from the tokens a server said it accepts. Each
// Pi level maps to the server's own spelling of it, or `null` when the server
// never offered it.
export function buildThinkingLevelMap(
  tokens: readonly string[],
): Record<PiThinkingLevel, string | null> {
  const available = new Set(tokens);
  const map = {} as Record<PiThinkingLevel, string | null>;
  for (const level of PI_THINKING_LEVELS) {
    if (level === 'off') {
      map.off = OFF_ALIASES.find((alias) => available.has(alias)) ?? null;
    } else {
      map[level] = available.has(level) ? level : null;
    }
  }
  return map;
}

// Keep only tokens we recognize, deduped and in Pi's order — the sanitizer for
// a `thinkingLevels` array arriving from globalSettings.json or a PATCH body.
export function sanitizeThinkingLevels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const found = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && KNOWN_TOKENS.includes(item)) found.add(item);
  }
  // An EMPTY array is the "probed, nothing beyond `high`" marker
  // (applyThinkingLevels) and must survive the settings round-trip: mapping it
  // to `undefined` left the model "unprobed" after every save, so each sweep
  // re-sent the capability probe and rewrote globalSettings.json. An array of
  // only unrecognized tokens still reads as unprobed.
  if (found.size === 0) return raw.length === 0 ? [] : undefined;
  return inTokenOrder(found);
}
