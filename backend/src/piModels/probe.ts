// Pi endpoint PROBE for Lattice — the "Detect models" half of Pi endpoint
// management.
//
//   - probeEndpointModels(): GET <baseUrl>/models for the "Detect models" button.
//
// The models.json reconciliation half lives in ./reconcile.ts.

import { validateHeaderName, validateHeaderValue } from 'node:http';
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

// Only explicitly configured literal headers reach probes. Do not interpolate
// environment variables or execute Pi's !command syntax in header values.
// Custom headers override defaults, case-insensitively; the last configured
// spelling wins when the custom map itself contains differently cased names.
// Validate every entry, including overridden entries, before sending anything.
function probeHeaders(apiKey: string | undefined, custom: unknown, json = false): Record<string, string> {
  const headers: Record<string, string> = Object.create(null);
  const key = resolveProbeKey(apiKey);
  if (key) headers.authorization = `Bearer ${key}`;
  if (json) headers['content-type'] = 'application/json';
  if (custom === undefined) return headers;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) {
    throw new Error('headers must be an object of string values');
  }
  for (const [name, value] of Object.entries(custom)) {
    if (typeof value !== 'string') throw new Error('headers must contain only string values');
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      // Do not echo a potentially secret value in the route error or sweep log.
      throw new Error('headers contain an invalid HTTP header name or value');
    }
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

// "Detect models" for the Settings → Pi endpoint form: GET <baseUrl>/models
// (OpenAI-compatible) and return each model id with any context length the
// server advertised. Throws on a non-OK response or network error so the route
// can surface it.
export async function probeEndpointModels(
  baseUrl: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<ProbedModel[]> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_MODELS_CONFIG.probeTimeoutMs);
  try {
    const headers = probeHeaders(apiKey, customHeaders);
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) throw new Error(`endpoint returned HTTP ${r.status}`);
    return parseProbedModels(await r.json());
  } finally {
    clearTimeout(timer);
  }
}

// The `reasoning_effort` sent by probeThinkingLevels below. Deliberately not a
// level name, and namespaced so it is obvious in a server log what sent it.
const INVALID_EFFORT = '__lattice_capability_probe__';

// Ask an endpoint which `reasoning_effort` values it accepts, by sending one it
// certainly does not. A server that validates the field answers 400 with a
// message enumerating the valid ones ("must be one of none, minimal, low,
// medium, high, xhigh, or max") — which is the whole answer, obtained without
// generating a single token, so it costs nothing even on a metered endpoint.
//
// Three outcomes, and the caller must tell them apart:
//   - tokens  → the server enumerated what it accepts; record them.
//   - []      → a 2xx: the server accepted the nonsense value, so it validates
//               nothing and its acceptance of `xhigh` would prove nothing
//               either. "Asked and answered, nothing to record" — persisted so
//               the model is not re-probed every sweep.
//   - null    → NO answer: network error / timeout, a status that isn't a
//               validation rejection (5xx, a 401 from a `$VAR` key the probe
//               deliberately doesn't resolve), or a rejection whose message
//               enumerates nothing recognizable. The caller must leave the
//               model UNTOUCHED — writing `[]` here would mark a model that was
//               merely unreachable as "ordinary" and clamp `xhigh`/`max` for
//               good, since the marker is what stops the next probe.
export async function probeThinkingLevels(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
  customHeaders?: Record<string, string>,
): Promise<string[] | null> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_MODELS_CONFIG.probeTimeoutMs);
  try {
    const headers = probeHeaders(apiKey, customHeaders, true);
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
    // Only a validation rejection carries the enumeration. Anything else (5xx,
    // 401/403, 404 on a server without chat completions) says nothing about
    // the model's levels — it is "no answer", not "no extended levels".
    if (r.status !== 400 && r.status !== 422) return null;
    const tokens = parseAcceptedEffortTokens(await r.text());
    return tokens.length > 0 ? tokens : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
