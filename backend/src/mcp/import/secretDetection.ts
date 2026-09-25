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

// ---- secrets embedded in a URL or command-line args -------------------------
//
// env / headers have a name→value slot the secrets file can take over; a `url`
// or an `args` list does not. A key embedded there (`?api_key=sk-…`,
// `https://user:token@host/…`, `--api-key sk-…`, mcp-remote's
// `--header Authorization:Bearer sk-…`) would otherwise reach the import scan
// response, the non-0600 globalSettings.json, and every spawned command line.
// These scanners find such secrets, return a REDACTED copy of the value and a
// description of each finding (names only — never the value). The importer
// keeps only the redacted copy and refuses to apply a flagged server.

export const REDACTED = '***';

// A secret-named flag / query param / `NAME=` whose value is NOT itself the
// secret (a path to a key file, an auth mode, an endpoint) — `--token-file`,
// `auth_mode`, `KEY_PATH`.
const BENIGN_NAME_SUFFIX_RE =
  /(?:file|path|dir|env|var|mode|type|url|uri|endpoint|method|provider|scheme|header)$/i;

const URL_SHAPE_RE = /^[a-z][a-z0-9+.\-]*:\/\//i;

export type EmbeddedSecretScan<T> = { redacted: T; findings: string[] };

function looksSecretParamName(name: string): boolean {
  const n = name.replace(/^-+/, '');
  return looksSecret(n) && !BENIGN_NAME_SUFFIX_RE.test(n);
}

// Also catches a secret after a scheme word (`Bearer sk-…`, `token ghp_…`).
function valueLooksSecret(value: string): boolean {
  return looksSecretValue(value) || value.trim().split(/\s+/).some(looksSecretValue);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

// `a=1&api_key=sk-…` (a query string or an `#access_token=…` fragment).
function redactParams(params: string, where: string, findings: string[]): string {
  return params
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) {
        if (pair && !isReference(pair) && looksSecretValue(safeDecode(pair))) {
          findings.push(`a secret-looking URL ${where} value`);
          return REDACTED;
        }
        return pair;
      }
      const name = safeDecode(pair.slice(0, eq));
      const value = safeDecode(pair.slice(eq + 1));
      if (!value || isReference(value)) return pair;
      if (looksSecretParamName(name) || valueLooksSecret(value)) {
        findings.push(`URL ${where} parameter "${name}"`);
        return `${pair.slice(0, eq)}=${REDACTED}`;
      }
      return pair;
    })
    .join('&');
}

// Credentialed userinfo, secret-named / secret-shaped query (and fragment)
// params, and secret-shaped path segments (`https://host/mcp/sk-…/sse`).
export function scanUrlForSecrets(url: string): EmbeddedSecretScan<string> {
  const findings: string[] = [];
  const m = /^([a-z][a-z0-9+.\-]*:\/\/)([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/is.exec(url.trim());
  if (!m) {
    return valueLooksSecret(url)
      ? { redacted: REDACTED, findings: ['a secret-looking URL'] }
      : { redacted: url, findings };
  }
  const [, scheme, rawAuthority, rawPath, query, fragment] = m;
  let authority = rawAuthority;
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    if (userinfo && !userinfo.split(':').every((p) => !p || isReference(p))) {
      findings.push('credentials in the URL (user:password@host)');
      authority = `${REDACTED}${authority.slice(at)}`;
    }
  }
  const path = rawPath
    .split('/')
    .map((seg) => {
      if (!seg || isReference(seg) || !looksSecretValue(safeDecode(seg))) return seg;
      findings.push('a secret-looking URL path segment');
      return REDACTED;
    })
    .join('/');
  let out = `${scheme}${authority}${path}`;
  if (query !== undefined) out += `?${redactParams(query, 'query', findings)}`;
  if (fragment !== undefined) out += `#${redactParams(fragment, 'fragment', findings)}`;
  return findings.length > 0 ? { redacted: out, findings } : { redacted: url, findings };
}

// A single value (a flag's value, an arg): URL-aware, else whole-value shape.
function scanValue(value: string): EmbeddedSecretScan<string> {
  if (URL_SHAPE_RE.test(value.trim())) return scanUrlForSecrets(value);
  return valueLooksSecret(value)
    ? { redacted: REDACTED, findings: ['a secret-looking value'] }
    : { redacted: value, findings: [] };
}

// `--api-key=sk-…`, `API_KEY=sk-…` (docker -e), `Authorization:Bearer sk-…`
// (mcp-remote --header), `--api-key sk-…` (value in the NEXT arg), a URL arg,
// or a bare secret-shaped arg.
export function scanArgsForSecrets(args: string[]): EmbeddedSecretScan<string[]> {
  const findings: string[] = [];
  const redacted = args.map((arg, i) => {
    if (isReference(arg)) return arg;
    const prev = i > 0 ? args[i - 1] : undefined;
    if (
      prev !== undefined &&
      /^-{1,2}[A-Za-z]/.test(prev) &&
      !/[=:]/.test(prev) &&
      looksSecretParamName(prev) &&
      !arg.startsWith('-')
    ) {
      findings.push(`the value after argument "${prev}"`);
      return REDACTED;
    }
    if (URL_SHAPE_RE.test(arg.trim())) {
      const r = scanUrlForSecrets(arg);
      for (const f of r.findings) findings.push(`${f} in argument ${i + 1}`);
      return r.redacted;
    }
    const kv = /^(-{0,2}[A-Za-z_][\w.-]*)\s*([=:])\s*([\s\S]*)$/.exec(arg);
    if (kv) {
      const [, name, sep, value] = kv;
      if (!value || isReference(value)) return arg;
      if (looksSecretParamName(name)) {
        findings.push(`the value of argument "${name}"`);
        return `${name}${sep}${REDACTED}`;
      }
      const r = scanValue(value);
      if (r.findings.length > 0) {
        findings.push(`the value of argument "${name}"`);
        return `${name}${sep}${r.redacted}`;
      }
      return arg;
    }
    if (valueLooksSecret(arg)) {
      findings.push(`argument ${i + 1}`);
      return REDACTED;
    }
    return arg;
  });
  return { redacted, findings };
}
