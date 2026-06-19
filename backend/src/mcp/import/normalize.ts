// Secret-classification normalizer: turn a raw per-tool MCP server entry into
// Lattice's `McpServerEntry` shape, splitting out secrets per MCP plan §8.
//
// A LITERAL value in env (whose var name looks secret) is captured for storage
// in ~/.lattice/mcpSecrets.json and kept OUT of the entry; a REFERENCE
// (`${input:…}`, `${env:…}`, `$VAR`, Codex `bearer_token_env_var`) is recorded
// as a secret env var with NO stored value, so it resolves from the ambient env.
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

function looksSecret(name: string): boolean {
  return SECRET_NAME_RE.test(name);
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

  if (isHttp) {
    entry.url = String(raw.url);
    // Headers are kept inline for v1 (no env-var indirection for HTTP headers
    // in the harness config). A Codex bearer_token_env_var is an ambient ref.
    if (raw.headers && typeof raw.headers === 'object') {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
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
        } else if (looksSecret(k)) {
          // Literal secret → store in the secrets file, keep out of the entry.
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
  return { entry, secrets, source };
}
