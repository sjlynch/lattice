// Pi model DISCOVERY for Lattice's harness selectors.
//
// `pi --list-models` prints every model Pi knows about — its built-in OAuth
// catalog (e.g. openai-codex/gpt-5.5) PLUS any custom providers declared in
// `~/.pi/agent/models.json` (e.g. a local vLLM server). That command is our
// non-hardcoded detection source: adding a provider to models.json makes its
// models appear here with zero Lattice code changes.
//
// We expose two things to the UI (over GET /api/pi-models):
//   - `models`: the full parsed list (for a future "model menu" curation UI).
//   - `menu`:   the curated subset surfaced as "Pi — X" rows in the harness
//               dropdowns. When the user hasn't curated a menu
//               (globalSettings.piModelMenu), the default is every model from a
//               models.json-declared provider plus Pi's current default model —
//               so the dropdown shows what the user actually configured rather
//               than all ~13 built-in entries.
//
// Read-only: this module never writes Pi config. Model SELECTION happens
// per-spawn via the `--model` flag (see worktree/commands.ts buildPiModelFlag);
// Pi's global defaults in ~/.pi/agent/settings.json are never touched. Endpoint
// MANAGEMENT (reconcile + probe, which DO write models.json) lives in
// ./management.ts.

import fs from 'node:fs/promises';
import path from 'node:path';
import { getUserSettings } from '../userSettings.js';
import { normalizePiModel } from '../worktree/commands.js';
import { spawnWithTimeout } from '../spawnWithTimeout.js';
import { PI_MODELS_CONFIG, piAgentDir } from './config.js';

export { normalizePiModel } from '../worktree/commands.js';

export type PiModelInfo = {
  provider: string;
  model: string;
  // `${provider}/${model}` — the value passed to `pi --model`.
  pattern: string;
  // Raw display strings from the table (e.g. "204.8K"); UI hints only.
  contextWindow?: string;
  thinking?: boolean;
};

export type PiMenuEntry = {
  pattern: string;
  // Friendly label WITHOUT the "Pi — " prefix (the frontend adds it).
  label: string;
};

export type PiModelsResult = {
  models: PiModelInfo[];
  menu: PiMenuEntry[];
  // Pi's currently-configured default model ("provider/model"), or null.
  defaultPattern: string | null;
};

let modelsCache: { at: number; models: PiModelInfo[] } | null = null;

// Parse the fixed-width `pi --list-models` table. Columns are separated by 2+
// spaces: `provider  model  context  max-out  thinking  images`. Exported for
// unit testing.
export function parsePiListModels(stdout: string): PiModelInfo[] {
  const out: PiModelInfo[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/\s{2,}/);
    if (cols.length < 2) continue;
    const [provider, model] = cols;
    if (!provider || !model) continue;
    // Skip the header row.
    if (provider === 'provider' && model === 'model') continue;
    // Defensive: a provider/model token should never contain whitespace.
    if (/\s/.test(provider) || /\s/.test(model)) continue;
    out.push({
      provider,
      model,
      pattern: `${provider}/${model}`,
      contextWindow: cols[2] || undefined,
      thinking: cols[4] ? cols[4].toLowerCase() === 'yes' : undefined,
    });
  }
  return out;
}

// Run `pi --list-models`, returning the combined output on a SUCCESSFUL spawn
// (even if empty) or `null` on a TRANSIENT failure (timeout / spawn error).
// The null-vs-string distinction is load-bearing: loadModels must not cache a
// transient failure as a successful empty listing (see reconcileModelsCache).
async function runListModels(): Promise<string | null> {
  const r = await spawnWithTimeout('pi', ['--list-models'], {
    // shell:true so Windows resolves `pi` → `pi.cmd`; args are static.
    shell: process.platform === 'win32',
    timeoutMs: PI_MODELS_CONFIG.listModelsTimeoutMs,
  });
  // Pi prints the table to STDERR, not stdout — parse the combined output so
  // we're robust to that (and to any future change). A timeout or spawn error
  // is a transient failure, signalled as null so we don't memoize it.
  if (r.timedOut || r.error) return null;
  return r.combined;
}

// Decide what loadModels returns and caches given a fresh probe result and the
// existing cache. Extracted + exported so the transient-failure behaviour is
// unit-testable without spawning `pi`.
//
// `raw === null` means the probe FAILED transiently (timeout / spawn error). We
// must NOT overwrite (or even create) the cache with an empty list in that case
// — doing so would blank the menu and drop curated built-in models (which live
// only in `pi --list-models`, never in models.json) for the full TTL. Instead
// fall back to the last good cache if we have one (a stale list beats a blank
// menu), else return [] for just this call WITHOUT memoizing it so the next
// call re-probes immediately rather than waiting out the TTL.
export function reconcileModelsCache(
  raw: string | null,
  prev: { at: number; models: PiModelInfo[] } | null,
  now: number,
): { models: PiModelInfo[]; cache: { at: number; models: PiModelInfo[] } | null } {
  if (raw === null) {
    return { models: prev?.models ?? [], cache: prev };
  }
  const models = parsePiListModels(raw);
  return { models, cache: { at: now, models } };
}

async function loadModels(): Promise<PiModelInfo[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < PI_MODELS_CONFIG.modelsCacheTtlMs) {
    return modelsCache.models;
  }
  const { models, cache } = reconcileModelsCache(
    await runListModels(),
    modelsCache,
    now,
  );
  modelsCache = cache;
  return models;
}

// Force a re-probe of `pi --list-models` — call after reconciling models.json
// (management.ts) so a newly-added provider shows up without waiting out the TTL.
export function resetPiModelsCache(): void {
  modelsCache = null;
}

type ModelsJson = {
  providers?: Record<
    string,
    { models?: Array<{ id?: string; name?: string }> }
  >;
};

async function readModelsJson(): Promise<ModelsJson | null> {
  try {
    const raw = await fs.readFile(path.join(piAgentDir(), 'models.json'), 'utf8');
    return JSON.parse(raw) as ModelsJson;
  } catch {
    return null;
  }
}

async function readDefaultPattern(): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(piAgentDir(), 'settings.json'), 'utf8');
    const s = JSON.parse(raw) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    if (s.defaultProvider && s.defaultModel) {
      return `${s.defaultProvider}/${s.defaultModel}`;
    }
    return null;
  } catch {
    return null;
  }
}

function buildMenu(
  models: PiModelInfo[],
  modelsJson: ModelsJson | null,
  defaultPattern: string | null,
  curated: string[] | undefined,
): PiMenuEntry[] {
  // Friendly names + the set of providers the user declared in models.json
  // (treated as "Lattice-managed-ish" for the default menu).
  const nameByPattern = new Map<string, string>();
  const customProviders = new Set<string>();
  for (const [pid, p] of Object.entries(modelsJson?.providers ?? {})) {
    customProviders.add(pid);
    for (const m of p?.models ?? []) {
      if (m?.id) nameByPattern.set(`${pid}/${m.id}`, m.name || m.id);
    }
  }
  const byPattern = new Map(models.map((m) => [m.pattern, m]));
  const labelFor = (pattern: string): string =>
    nameByPattern.get(pattern) ?? byPattern.get(pattern)?.model ?? pattern;

  let patterns: string[];
  if (curated && curated.length > 0) {
    patterns = curated;
  } else {
    // Default: every model from a models.json-declared provider, plus Pi's
    // current default model. Keeps the dropdown to what the user configured.
    const set = new Set<string>();
    for (const info of models) {
      if (customProviders.has(info.provider)) set.add(info.pattern);
    }
    if (defaultPattern) set.add(defaultPattern);
    patterns = [...set];
  }

  // Keep only patterns that still exist — either reported by `pi --list-models`
  // OR declared in models.json. The models.json fallback matters because that
  // CLI call is fragile: a transient spawn failure (or Pi rejecting one bad
  // provider, which drops every custom provider from the listing) would
  // otherwise silently hide models the user explicitly curated. Dedupe,
  // preserve order.
  const valid = (pattern: string): boolean =>
    byPattern.has(pattern) || nameByPattern.has(pattern);
  const seen = new Set<string>();
  const entries: PiMenuEntry[] = [];
  for (const pattern of patterns) {
    if (seen.has(pattern) || !valid(pattern)) continue;
    seen.add(pattern);
    entries.push({ pattern, label: labelFor(pattern) });
  }
  return entries;
}

// The full picture for the harness dropdowns. `curated` comes from
// globalSettings.piModelMenu (empty/undefined → the default menu above).
export async function getPiModels(curated?: string[]): Promise<PiModelsResult> {
  const [models, modelsJson, defaultPattern] = await Promise.all([
    loadModels(),
    readModelsJson(),
    readDefaultPattern(),
  ]);
  return {
    models,
    menu: buildMenu(models, modelsJson, defaultPattern, curated),
    defaultPattern,
  };
}

// Resolve the Pi model to use for a project when a spawn didn't carry one
// explicitly — falls back to the per-project default (UserSettings.piModel).
export async function resolvePiModel(
  projectPath: string,
): Promise<string | undefined> {
  try {
    const settings = await getUserSettings(projectPath);
    return normalizePiModel(settings.piModel);
  } catch {
    return undefined;
  }
}
