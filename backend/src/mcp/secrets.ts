// MCP API keys, stored in their OWN file (`~/.lattice/mcpSecrets.json`, chmod
// 0600) — never in globalSettings.json or a project's userSettings.json. Keeping
// secret bytes physically separate makes redaction structural: the settings
// endpoints literally cannot leak a key because they never read this file, and
// `redactSecrets()` is the only shape that ever crosses backend → browser.
//
// `0600` is best-effort (POSIX owner-only). On Windows it is largely inert; the
// real guard there is the per-user `~/.lattice/` profile location.

import fs from 'node:fs/promises';
import path from 'node:path';
import { latticeHomeDir } from '../projectPath.js';
import { atomicWriteFile } from '../claudeTrust.js';
import { runExclusive } from '../serializeWrites.js';

// { [serverId]: { [envVar]: value } }
export type McpSecrets = Record<string, Record<string, string>>;

// Redacted form: presence-only booleans, safe to return to the browser.
export type RedactedMcpSecrets = Record<string, Record<string, boolean>>;

function secretsFile(): string {
  return path.join(latticeHomeDir(), 'mcpSecrets.json');
}

// All read-modify-write paths over the secrets file share this key so a
// `setMcpSecret` and a `mergeMcpSecrets` (or two of either) firing close
// together serialize instead of each reading the same base and the later write
// dropping the earlier secret (see ../serializeWrites.ts).
function secretsWriteKey(): string {
  return `mcpSecrets:${secretsFile()}`;
}

export async function readMcpSecrets(): Promise<McpSecrets> {
  try {
    const raw = await fs.readFile(secretsFile(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return sanitizeSecrets(parsed);
  } catch {
    return {};
  }
}

function sanitizeSecrets(raw: unknown): McpSecrets {
  if (!raw || typeof raw !== 'object') return {};
  const out: McpSecrets = {};
  for (const [serverId, vars] of Object.entries(raw as Record<string, unknown>)) {
    if (!vars || typeof vars !== 'object') continue;
    const inner: Record<string, string> = {};
    for (const [envVar, value] of Object.entries(vars as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) inner[envVar] = value;
    }
    if (Object.keys(inner).length > 0) out[serverId] = inner;
  }
  return out;
}

async function writeMcpSecrets(secrets: McpSecrets): Promise<void> {
  const file = secretsFile();
  await fs.mkdir(latticeHomeDir(), { recursive: true });
  // Shared atomic writer: cleans up its temp on a failed rename (this used to
  // leak `.lattice-*.tmp` orphans the same way ~/.claude.json did) and retries
  // through transient Windows file-locks.
  await atomicWriteFile(file, JSON.stringify(secrets, null, 2));
  // Best-effort owner-only perms (inert on Windows).
  await fs.chmod(file, 0o600).catch(() => {});
}

// Set (or, with value === null, clear) a single secret. Returns the updated
// redacted view so the caller can echo presence back to the browser.
export async function setMcpSecret(
  serverId: string,
  envVar: string,
  value: string | null,
): Promise<RedactedMcpSecrets> {
  return runExclusive(secretsWriteKey(), async () => {
    const secrets = await readMcpSecrets();
    if (value === null || value === '') {
      if (secrets[serverId]) {
        delete secrets[serverId][envVar];
        if (Object.keys(secrets[serverId]).length === 0) delete secrets[serverId];
      }
    } else {
      (secrets[serverId] ??= {})[envVar] = value;
    }
    await writeMcpSecrets(secrets);
    return redactSecrets(secrets);
  });
}

// Merge in multiple secrets at once (used by config import). Skips empty values.
export async function mergeMcpSecrets(
  incoming: McpSecrets,
): Promise<RedactedMcpSecrets> {
  return runExclusive(secretsWriteKey(), async () => {
    const secrets = await readMcpSecrets();
    for (const [serverId, vars] of Object.entries(incoming)) {
      for (const [envVar, value] of Object.entries(vars)) {
        if (typeof value === 'string' && value.length > 0) {
          (secrets[serverId] ??= {})[envVar] = value;
        }
      }
    }
    await writeMcpSecrets(secrets);
    return redactSecrets(secrets);
  });
}

export function redactSecrets(secrets: McpSecrets): RedactedMcpSecrets {
  const out: RedactedMcpSecrets = {};
  for (const [serverId, vars] of Object.entries(secrets)) {
    out[serverId] = {};
    for (const envVar of Object.keys(vars)) out[serverId][envVar] = true;
  }
  return out;
}

// Last-4 hints (e.g. "••••cD3f") so the UI can confirm WHICH key is stored
// without exposing it. Only the tail is ever revealed.
export type McpSecretHints = Record<string, Record<string, string>>;

export function secretHints(secrets: McpSecrets): McpSecretHints {
  const out: McpSecretHints = {};
  for (const [serverId, vars] of Object.entries(secrets)) {
    out[serverId] = {};
    for (const [envVar, value] of Object.entries(vars)) {
      const tail = value.slice(-4);
      out[serverId][envVar] = `••••${tail}`;
    }
  }
  return out;
}
