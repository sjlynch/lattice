// Pi endpoint PROBE for Lattice — the "Detect models" half of Pi endpoint
// management.
//
//   - probeEndpointModels(): GET <baseUrl>/models for the "Detect models" button.
//
// The models.json reconciliation half lives in ./reconcile.ts.

import { PI_MODELS_CONFIG } from './config.js';
import { parseAcceptedEffortTokens } from './thinkingLevels.js';

// One model an OpenAI-compatible endpoint reports, plus whatever usable
// metadata rode along with it.
export type ProbedModel = {
  id: string;
  // The context length the SERVER reports, when it reports one. Pi sizes its
  // own budget from the `contextWindow` in models.json; with none, it falls
  // back to a conservative default — so on a 262k-token local server most of
  // the machine's capability would stay invisible to the agent unless the user
  // happened to know the number and type it in. Detecting it is what makes a
  // freshly-added endpoint usable without hand-tuning.
  contextWindow?: number;
};

// OpenAI's `/v1/models` schema carries no context field, so each server invents
// its own spelling. Read the common ones in order and take the first sane
// positive integer:
//   max_model_len      — vLLM, NInfer, SGLang
//   context_length     — llama.cpp, LM Studio, OpenRouter
//   max_context_length — KoboldCpp / TabbyAPI style
//   context_window     — misc. OpenAI-compatible shims
// A server that reports none simply yields no contextWindow (Pi's default).
// Deliberately not a level name, and namespaced so it is obvious in a server
// log what sent it.
const INVALID_EFFORT = '__lattice_capability_probe__';

const CONTEXT_KEYS = [
  'max_model_len',
  'context_length',
  'max_context_length',
  'context_window',
] as const;

function readContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const key of CONTEXT_KEYS) {
    const raw = entry[key];
    // Only a number or a numeric string — `Number(true)` is 1, which would
    // otherwise turn a boolean flag into a 1-token context window.
    if (typeof raw !== 'number' && typeof raw !== 'string') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

// Pull the model entries out of an OpenAI-compatible `/models` payload.
// Exported for unit testing against the shapes real servers return.
export function parseProbedModels(payload: unknown): ProbedModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ProbedModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !entry.id) continue;
    const contextWindow = readContextWindow(entry);
    out.push(contextWindow === undefined ? { id: entry.id } : { id: entry.id, contextWindow });
  }
  return out;
}

// For a probe, use only a LITERAL apiKey value as the bearer token.
//
// Pi's own resolution (docs/models.md "Value Resolution") is: `!cmd` executes a
// shell command, `$VAR` / `${VAR}` interpolates the environment, and anything
// else — including a bare uppercase `MY_API_KEY` — is a literal. Probes
// deliberately do neither of the first two: a user-supplied probe URL must never
// receive ambient process secrets, and nothing should execute an arbitrary
// command on a timer. So a `$VAR`-keyed endpoint probes UNAUTHENTICATED (or with
// the un-interpolated text) and will usually answer 401 — auto-discovery then
// keeps its last known models and logs why. Such an endpoint has to be
// configured by hand in globalSettings.json.
function resolveProbeKey(apiKey?: string): string | undefined {
  const key = apiKey?.trim();
  if (!key) return undefined;
  if (key.startsWith('!')) return undefined;
  return key;
}

// "Detect models" for the Settings → Pi endpoint form: GET <baseUrl>/models
// (OpenAI-compatible) and return each model id with any context length the
// server advertised. Throws on a non-OK response or network error so the route
// can surface it.
export async function probeEndpointModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ProbedModel[]> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_MODELS_CONFIG.probeTimeoutMs);
  try {
    const headers: Record<string, string> = {};
    const key = resolveProbeKey(apiKey);
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) throw new Error(`endpoint returned HTTP ${r.status}`);
    return parseProbedModels(await r.json());
  } finally {
    clearTimeout(timer);
  }
}

// Ask an endpoint which `reasoning_effort` values it accepts, by sending one it
// certainly does not. A server that validates the field answers 400 with a
// message enumerating the valid ones ("must be one of none, minimal, low,
// medium, high, xhigh, or max") — which is the whole answer, obtained without
// generating a single token, so it costs nothing even on a metered endpoint.
//
// Returns [] whenever the answer isn't trustworthy: the server accepted the
// nonsense value (so it validates nothing and tells us nothing), the error was
// unparseable, or the request failed. The caller then leaves the model as-is
// rather than writing a map built on a guess.
export async function probeThinkingLevels(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
): Promise<string[]> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_MODELS_CONFIG.probeTimeoutMs);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = resolveProbeKey(apiKey);
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'hi' }],
        // Bounded in case a lenient server runs the request anyway.
        max_tokens: 1,
        reasoning_effort: INVALID_EFFORT,
      }),
    });
    // A 2xx means the server ignored an obviously invalid value, so its
    // acceptance of `xhigh` would prove nothing either.
    if (r.ok) return [];
    return parseAcceptedEffortTokens(await r.text());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
