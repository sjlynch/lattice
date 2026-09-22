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

// Lenient read for the READ paths (spawn resolution, the redacted GET): a file
// that can't be read or parsed reads as "no secrets" so a session still spawns.
// Never use this as the base of a read-modify-write — see readMcpSecretsStrict.
export async function readMcpSecrets(): Promise<McpSecrets> {
  try {
    return await readMcpSecretsStrict();
  } catch {
    return {};
  }
}

// Strict read for the WRITE paths. `{}` only when the file is genuinely absent
// (ENOENT); any other read error (a transient EBUSY/EPERM lock) or a parse
// failure THROWS, because the writers below read-modify-write whatever this
// returns — with the lenient `{}` a single transient failure followed by
// saving one key silently wiped every other stored secret. The route lets the
// error through as a 500 whose message says why (express-async-errors).
export async function readMcpSecretsStrict(): Promise<McpSecrets> {
  const file = secretsFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    throw new Error(
      `MCP secrets file unreadable (${file}: ${(err as Error).message}) — refusing to overwrite it`,
    );
  }
  let parsed: unknown;
  try {
    // A UTF-8 BOM (an editor's doing) is not a reason to refuse.
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(
      `MCP secrets file is not valid JSON (${file}: ${(err as Error).message}) — refusing to overwrite it`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`MCP secrets file is not a JSON object (${file}) — refusing to overwrite it`);
  }
  return sanitizeSecrets(parsed);
}

// Keys that, used as a plain-object property name, reach Object.prototype
// instead of adding an entry: `secrets.constructor` is the inherited Object
// function, so `(secrets[id] ??= {})[k] = v` with id "constructor" and k
// "keys" replaced the process-wide Object.keys (every later call threw until a
// restart), and "__proto__" wrote onto Object.prototype. Server ids and env
// var names arrive in HTTP bodies and imported configs, so refuse them.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeSecretKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && !UNSAFE_KEYS.has(key);
}

// Own-property lookup: never resolves an inherited member as a server's map.
function ownVars(secrets: McpSecrets, serverId: string): Record<string, string> | undefined {
  return Object.hasOwn(secrets, serverId) ? secrets[serverId] : undefined;
}

function sanitizeSecrets(raw: unknown): McpSecrets {
  if (!raw || typeof raw !== 'object') return {};
  const out: McpSecrets = {};
  for (const [serverId, vars] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeSecretKey(serverId) || !vars || typeof vars !== 'object') continue;
    const inner: Record<string, string> = {};
    for (const [envVar, value] of Object.entries(vars as Record<string, unknown>)) {
      if (!isSafeSecretKey(envVar)) continue;
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
  if (!isSafeSecretKey(serverId) || !isSafeSecretKey(envVar)) {
    throw new Error(
      `refusing MCP secret key ${JSON.stringify(serverId)}/${JSON.stringify(envVar)}`,
    );
  }
  return runExclusive(secretsWriteKey(), async () => {
    const secrets = await readMcpSecretsStrict();
    const vars = ownVars(secrets, serverId);
    if (value === null || value === '') {
      if (vars) {
        delete vars[envVar];
        if (Object.keys(vars).length === 0) delete secrets[serverId];
      }
    } else {
      (vars ?? (secrets[serverId] = {}))[envVar] = value;
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
    const secrets = await readMcpSecretsStrict();
    for (const [serverId, vars] of Object.entries(incoming)) {
      if (!isSafeSecretKey(serverId)) continue;
      for (const [envVar, value] of Object.entries(vars)) {
        if (!isSafeSecretKey(envVar)) continue;
        if (typeof value === 'string' && value.length > 0) {
          (ownVars(secrets, serverId) ?? (secrets[serverId] = {}))[envVar] = value;
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
// without exposing it. Only the tail is ever revealed — and only for a value
// long enough that four characters are a small part of it: `slice(-4)` of a
// 4-char secret was the whole secret, sent to the browser.
const MIN_HINTED_SECRET_LENGTH = 12;
export type McpSecretHints = Record<string, Record<string, string>>;

export function secretHints(secrets: McpSecrets): McpSecretHints {
  const out: McpSecretHints = {};
  for (const [serverId, vars] of Object.entries(secrets)) {
    out[serverId] = {};
    for (const [envVar, value] of Object.entries(vars)) {
      const tail = value.length >= MIN_HINTED_SECRET_LENGTH ? value.slice(-4) : '';
      out[serverId][envVar] = `••••${tail}`;
    }
  }
  return out;
}
