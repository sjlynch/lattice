// Secret-classification normalizer: turn a raw per-tool MCP server entry into
// Lattice's `McpServerEntry` shape, splitting out secrets per MCP plan §8.
//
// A LITERAL value in env OR an HTTP header that looks secret — either by NAME
// (key/token/auth/…) or by VALUE SHAPE (a known token prefix like sk-/ghp_/xox,
// a credentialed connection string, or a high-entropy opaque token) — is captured
// for storage in ~/.lattice/mcpSecrets.json and kept OUT of the entry; a
// REFERENCE (`${input:…}`, `${env:…}`, `$VAR`, Codex `bearer_token_env_var`) is
// recorded with NO stored value (env: resolves from the ambient env; header: a
// placeholder the user still has to supply). Env keys go to `secretEnvVars`,
// header names to `secretHeaders`; the resolver re-injects both at spawn.
//
// The value-shape check matters because globalSettings.json (where the entry's
// inline `env` is persisted) is NOT chmod 0600 and is documented as never
// holding secret values. A literal secret under a benign-looking var name
// (OPENAI_ORG=sk-proj-…, PAT=ghp_…, DSN=postgres://u:p@host) must not leak there
// just because its name doesn't trip the name regex. We bias toward "secret":
// a false positive only routes plain config into the 0600 secrets file (still
// injected at resolve time), while a false negative leaks a key into a
// world-readable settings file.
// These rules are security-relevant — see the unit tests in mcp.test.ts.

import { type McpServerEntry } from '../catalog.js';

// ---- internal normalized form (keeps literal secret values for apply) -------

export type Normalized = {
  entry: McpServerEntry;
  secrets: Record<string, string>; // envVar -> literal value to store
  source: string;
};

export type RawServer = {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  type?: unknown;
  bearer_token_env_var?: unknown;
};

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

function looksSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}
// Value-shape secret detection — catches a literal key whose var name is benign
// (so `looksSecret(name)` misses it) but whose value is unmistakably a secret.
function looksSecretValue(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return (
    SECRET_VALUE_PREFIX_RE.test(v) ||
    CREDENTIALED_URI_RE.test(v) ||
    looksHighEntropyToken(v)
  );
}
function isReference(value: string): boolean {
  return REFERENCE_RE.test(value.trim());
}

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

function detectRuntime(command: string | undefined): McpServerEntry['runtime'] {
  const c = (command ?? '').toLowerCase();
  if (c === 'uvx' || c === 'uv') return 'uv';
  if (c === 'docker') return 'docker';
  return 'node';
}

// Exported for unit testing — the secret-classification rules here are
// security-relevant (a literal key must land in the secrets file, not inline in
// globalSettings; a reference must stay unstored for ambient resolution).
export function normalizeServer(
  name: string,
  raw: RawServer,
  source: string,
): Normalized | null {
  if (!raw || typeof raw !== 'object') return null;
  const isHttp = typeof raw.url === 'string' && raw.url.length > 0;
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  if (!isHttp && !command) return null; // nothing runnable

  const entry: McpServerEntry = {
    id: name,
    label: name,
    description: `Imported from ${source}.`,
    transport: isHttp ? 'http' : 'stdio',
    runtime: isHttp ? 'remote' : detectRuntime(command),
    harnessSupport: { claude: true, codex: true, pi: false },
    builtin: false,
  };

  const secrets: Record<string, string> = {};
  const secretEnvVars: string[] = [];
  const secretHeaders: string[] = [];

  if (isHttp) {
    entry.url = String(raw.url);
    // Headers get the SAME secret classification as stdio env (below): an auth
    // header carrying a literal key (`Authorization: Bearer sk-…`, `X-Api-Key:
    // …`) must not land inline in the (non-0600) globalSettings.json. Detected
    // literal header secrets route to ~/.lattice/mcpSecrets.json via header-level
    // indirection — stored keyed by header name, recorded in `secretHeaders`,
    // and re-injected by the resolver (claudeServerConfig.toClaudeConfig) at
    // spawn time. Only plain headers (Accept, Content-Type, …) stay inline.
    if (raw.headers && typeof raw.headers === 'object') {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof v !== 'string') continue;
        if (isReference(v)) {
          // ${input:…} / ${env:…} placeholder — not a real value. Record the
          // header (so the import UI shows a key is needed) but store nothing and
          // keep the useless placeholder out of the entry.
          secretHeaders.push(k);
        } else if (looksSecret(k) || looksSecretValue(v)) {
          // Literal secret — by header NAME (Authorization/X-Api-Key/… all trip
          // the name regex) OR value shape → secrets file, kept out of inline.
          secrets[k] = v;
          secretHeaders.push(k);
        } else {
          headers[k] = v; // plain header, fine to keep inline
        }
      }
      if (Object.keys(headers).length > 0) entry.headers = headers;
    }
    if (typeof raw.bearer_token_env_var === 'string' && raw.bearer_token_env_var) {
      secretEnvVars.push(raw.bearer_token_env_var); // reference; no value stored
    }
  } else {
    entry.command = command;
    entry.args = asStringArray(raw.args);
    const inlineEnv: Record<string, string> = {};
    if (raw.env && typeof raw.env === 'object') {
      for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
        if (typeof v !== 'string') continue;
        if (isReference(v)) {
          // ${input:…} / ${env:…} / $VAR → ambient reference, no stored value.
          secretEnvVars.push(k);
        } else if (looksSecret(k) || looksSecretValue(v)) {
          // Literal secret — by var name OR value shape → store in the secrets
          // file, keep out of the (non-0600) inline entry env.
          secrets[k] = v;
          secretEnvVars.push(k);
        } else {
          inlineEnv[k] = v; // plain config, fine to keep inline
        }
      }
    }
    if (Object.keys(inlineEnv).length > 0) entry.env = inlineEnv;
  }

  if (secretEnvVars.length > 0) entry.secretEnvVars = [...new Set(secretEnvVars)];
  if (secretHeaders.length > 0) entry.secretHeaders = [...new Set(secretHeaders)];
  return { entry, secrets, source };
}
