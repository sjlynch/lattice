// MCP secret classification — the security-critical core of config import,
// split out from normalize.ts so the detection surface is auditable in isolation.
//
// Given an env/header value we decide one of three things:
//   - it is a REFERENCE (`${input:…}`, `${env:…}`, `$VAR`) → `isReference`
//   - its NAME or VALUE SHAPE marks it a literal secret → `looksSecret(name)`
//     / `looksSecretValue(value)`
//   - neither → plain config, safe to keep inline in the entry.
//
// A literal secret is captured for ~/.lattice/mcpSecrets.json (0600) and kept
// OUT of the entry; a reference is recorded with no stored value. The value-shape
// check matters because globalSettings.json (where an entry's inline `env` is
// persisted) is NOT chmod 0600 and is documented as never holding secret values.
// A literal secret under a benign-looking var name (OPENAI_ORG=sk-proj-…,
// PAT=ghp_…, DSN=postgres://u:p@host) must not leak there just because its name
// doesn't trip the name regex.
//
// We BIAS TOWARD "secret": a false positive only routes plain config into the
// 0600 secrets file (still injected at resolve time), while a false negative
// leaks a key into a world-readable settings file.
//
// Four detection methods back `looksSecretValue`: (1) name regex, (2) known
// vendor token prefixes, (3) credentialed connection URIs, (4) high-entropy
// opaque tokens. These rules are security-relevant — see the unit tests in
// __tests__/mcp.import.test.ts (exercised via `normalizeServer`).

const SECRET_NAME_RE = /(key|token|secret|password|passwd|auth|credential|apikey)/i;
const REFERENCE_RE = /\$\{[^}]+\}|^\$[A-Z_][A-Z0-9_]*$/;

// Vendor token prefixes (case-sensitive — these are emitted verbatim by the
// issuing service): OpenAI/Anthropic sk-…, Stripe (s|p)k_(live|test)_, GitHub
// gh[pousr]_/github_pat_, GitLab glpat-, Slack xox[baoprs]-, AWS AKIA/ASIA,
// Google AIza/ya29., npm npm_, Hugging Face hf_, DigitalOcean dop_v1_, Shopify
// shpat_/shpss_.
const SECRET_VALUE_PREFIX_RE =
  /^(?:sk-|[sp]k_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baoprs]-|AKIA|ASIA|AIza|ya29\.|npm_|hf_|dop_v1_|shpat_|shpss_)/;

// A connection string carrying inline credentials: scheme://userinfo@host
// (e.g. postgres://user:pass@host/db, redis://:pass@host, https://key@sentry/…).
// The userinfo run forbids `/` so a plain URL (https://host/path) never matches.
const CREDENTIALED_URI_RE = /^[a-z][a-z0-9+.\-]*:\/\/[^/\s@]+@/i;

// Shannon entropy in bits per character — high for random tokens, low for words.
function entropyPerChar(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// A long, opaque, mixed-class token with high entropy — a secret with no
// recognizable prefix. Constrained to a single-token shape (no `/`, `.`, `:`,
// or whitespace) so file paths, URLs, and plain config words can't trip it.
function looksHighEntropyToken(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{24,}$/.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false; // needs both classes
  return entropyPerChar(value) >= 3.5;
}

export function looksSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

// Value-shape secret detection — catches a literal key whose var name is benign
// (so `looksSecret(name)` misses it) but whose value is unmistakably a secret.
export function looksSecretValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return (
    SECRET_VALUE_PREFIX_RE.test(v) ||
    CREDENTIALED_URI_RE.test(v) ||
    looksHighEntropyToken(v)
  );
}

export function isReference(value: string): boolean {
  return REFERENCE_RE.test(value.trim());
}
