import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
// Import the constant from the leaf paths module, NOT from `../tasks.js` (which
// re-exports the whole task cache). This keeps userSettings — and therefore the
// MCP registry / detached terminal-server that now read it at spawn time — free
// of the heavy taskCache import chain.
import { PROJECT_DIR_NAME } from '../taskCache/paths.js';
import { canonicalProjectPath } from '../projectPath.js';
import { runExclusive } from '../serializeWrites.js';
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
  return settings;
}

export async function getUserSettings(projectPath: string): Promise<UserSettings> {
  const key = canonicalProjectPath(projectPath);
  try {
    const raw = await fs.readFile(settingsFile(key), 'utf8');
    return normalizeUserSettings(JSON.parse(raw) as UserSettings);
  } catch {
    return {};
  }
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
    const current = await getUserSettings(key);
    const updated = { ...current, ...normalizeUserSettings({ ...partial }) };
    const dir = path.join(key, PROJECT_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(settingsFile(key), JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  });
}
