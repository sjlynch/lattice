import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../claudeTrust/configFile.js';
// Import the constant from the leaf paths module, NOT from `../tasks.js` (which
// re-exports the whole task cache). This keeps userSettings — and therefore the
// MCP registry / detached terminal-server that now read it at spawn time — free
// of the heavy taskCache import chain.
import { PROJECT_DIR_NAME } from '../taskCache/paths.js';
import { canonicalProjectPath } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
// Leaf module (no imports) — keeps the catalog out of userSettings' chain.
import { RETIRED_BUILTIN_MCP_IDS } from '../mcp/retiredServers.js';
import type { StartupTerminal, UserSettings } from './types.js';

function settingsFile(projectPath: string): string {
  return path.join(projectPath, PROJECT_DIR_NAME, 'userSettings.json');
}

// `startupTerminals` is the one setting agents actually hand-write (they PATCH
// /api/settings directly), and the only one whose shape the UI trusts field by
// field: the Settings dialog renders `label`/`command` into controlled inputs
// and keys + matches rows by `id`, and the sidebar matches a running pty to its
// config by `id`. So an entry that guessed the field names — `{name, command}`,
// no `id`, no `label` — didn't fail at the API. It sat on disk until the dialog
// hit `label.trim()`, threw, and left that project's settings permanently
// un-editable *through the UI that would have fixed it* (2026-08-26,
// interview_eci). Coerce entries to the real shape here, at the I/O boundary,
// so neither a bad PATCH nor an already-corrupt file can reach a consumer.
//
// Minted ids must be DETERMINISTIC — the frontend matches a live startup pty to
// its config by id (`startupId === cfg.id`), so an id that changed between two
// reads of the same file would spawn a duplicate terminal on every reload.
// Hence content-addressing rather than a counter or a random suffix.
function mintStartupTerminalId(label: string, command: string): string {
  const digest = createHash('sha1')
    .update(JSON.stringify([label, command]))
    .digest('hex');
  return `st_${digest.slice(0, 12)}`;
}

// Accepts the plausible aliases an agent reaches for when it guesses the shape
// (`name`/`title` for `label`) rather than dropping the row: the user asked for
// that command to run at startup, and silently discarding it is worse than
// running it under a coerced label.
function normalizeStartupTerminals(raw: unknown): StartupTerminal[] {
  if (!Array.isArray(raw)) return [];
  const out: StartupTerminal[] = [];
  const used = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const command = typeof e.command === 'string' ? e.command.trim() : '';
    // A row with no command is a no-op the UI would drop on its next save
    // anyway (cleanStartupTerminals does the same), so drop it here too.
    if (!command) continue;
    const labelAlias = [e.label, e.name, e.title].find(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    const label = labelAlias ? labelAlias.trim() : 'startup';
    let id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!id || used.has(id)) {
      id = mintStartupTerminalId(label, command);
      // Two identical rows would content-address to the same id; disambiguate
      // so `id` stays the unique key the UI relies on.
      let n = 2;
      const base = id;
      while (used.has(id)) id = `${base}_${n++}`;
    }
    used.add(id);
    out.push({ id, label, command });
  }
  return out;
}

// Coerce the fields whose shape the rest of the app takes on trust. Applied on
// every read AND to every incoming patch, so a corrupt file heals on read and a
// bad write never lands. Only fields that can brick a consumer belong here —
// this is a boundary guard, not a schema validator.
function normalizeUserSettings<T extends Partial<UserSettings>>(settings: T): T {
  if ('startupTerminals' in settings) {
    settings.startupTerminals = normalizeStartupTerminals(
      settings.startupTerminals,
    );
  }
  if (settings.mcpOverrides && typeof settings.mcpOverrides === 'object') {
    settings.mcpOverrides = withoutRetiredMcpIds(settings.mcpOverrides);
  }
  const harnessMaps = settings.mcpHarnessOverrides;
  if (harnessMaps && typeof harnessMaps === 'object') {
    const next: NonNullable<UserSettings['mcpHarnessOverrides']> = { ...harnessMaps };
    for (const harness of ['codex', 'pi'] as const) {
      const map = next[harness];
      if (map && typeof map === 'object') next[harness] = withoutRetiredMcpIds(map);
    }
    settings.mcpHarnessOverrides = next;
  }
  return settings;
}

// Drop toggles for built-in MCP servers that no longer exist, so a stale
// `context7: true` can never switch on a custom server that later takes the same
// id (see mcp/retiredServers.ts). A new object; the input is left alone.
function withoutRetiredMcpIds(map: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(map).filter(([id]) => !RETIRED_BUILTIN_MCP_IDS.has(id)),
  );
}

async function readUserSettings(
  projectPath: string,
  fallbackOnError: boolean,
): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  try {
    const raw = await fs.readFile(settingsFile(key), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Valid JSON that isn't a settings object (`[]`, `null`, `"x"`) is as
    // unreadable as a parse error: a PATCH merged over `[]` would otherwise
    // write `{...patch}` and discard whatever the file held.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${settingsFile(key)} does not hold a settings object`);
    }
    return normalizeUserSettings(parsed as UserSettings);
  } catch (err) {
    // Display-only reads may use defaults; a PATCH must never merge them
    // over an existing file whose bytes could not be read or parsed.
    if (!fallbackOnError && (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return {};
  }
}

export async function getUserSettings(projectPath: string): Promise<UserSettings> {
  return readUserSettings(projectPath, true);
}

// Read-modify-write under the same per-project lock as patchUserSettings, with
// the patch computed FROM the settings read inside the lock (strictly: an
// unreadable file throws rather than reading as `{}`). For callers that merge
// into a nested field — reading it with getUserSettings and patching later
// wrote a stale snapshot of the whole field over a Settings save that landed
// in between, or wiped it outright when the lenient read returned `{}`.
// Returning `null` from `fn` skips the write.
export async function updateUserSettings(
  projectPath: string,
  fn: (current: UserSettings) => Partial<UserSettings> | null,
): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  return runExclusive(`userSettings:${key}`, async () => {
    const current = await readUserSettings(key, false);
    const partial = fn(current);
    if (partial === null) return current;
    const updated = { ...current, ...normalizeUserSettings({ ...partial }) };
    await fs.mkdir(path.join(key, PROJECT_DIR_NAME), { recursive: true });
    await atomicWriteFile(settingsFile(key), JSON.stringify(updated, null, 2));
    return updated;
  });
}

export async function patchUserSettings(
  projectPath: string,
  partial: Partial<UserSettings>,
): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  // Serialize per-project so concurrent patches with disjoint fields don't
  // each read the same base and clobber one another's write (see
  // serializeWrites.ts). The read happens INSIDE the critical section so each
  // patch sees the prior write's result.
  return runExclusive(`userSettings:${key}`, async () => {
    const current = await readUserSettings(key, false);
    const updated = { ...current, ...normalizeUserSettings({ ...partial }) };
    const dir = path.join(key, PROJECT_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    await atomicWriteFile(settingsFile(key), JSON.stringify(updated, null, 2));
    return updated;
  });
}
