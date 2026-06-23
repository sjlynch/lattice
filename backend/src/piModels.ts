// Pi model discovery for Lattice's harness selectors.
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
// Pi's global defaults in ~/.pi/agent/settings.json are never touched.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getUserSettings } from './userSettings.js';
import { latticeHomeDir } from './projectPath.js';
import { getGlobalSettings, type PiProvider } from './globalSettings.js';
import { normalizePiModel } from './worktree/commands.js';

export { normalizePiModel } from './worktree/commands.js';

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

const LIST_MODELS_TIMEOUT_MS = 8000;
// `pi --list-models` shells out to the CLI; cache the parsed result briefly so
// repeated dropdown opens don't each spawn a process. Config files (models.json
// / settings.json) are cheap and read fresh on every call so a curation edit
// shows up immediately.
const MODELS_CACHE_TTL_MS = 30_000;

let modelsCache: { at: number; models: PiModelInfo[] } | null = null;

function piAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}

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

function runListModels(): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      // shell:true so Windows resolves `pi` → `pi.cmd`; args are static.
      child = spawn('pi', ['--list-models'], {
        shell: process.platform === 'win32',
        windowsHide: true,
      });
    } catch {
      resolve('');
      return;
    }
    // Pi prints the table to STDERR, not stdout — capture both and parse the
    // combined output so we're robust to that (and to any future change).
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    const timer = setTimeout(() => {
      try {
        child!.kill();
      } catch {
        /* already exited */
      }
      resolve('');
    }, LIST_MODELS_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

async function loadModels(): Promise<PiModelInfo[]> {
  const now = Date.now();
  if (modelsCache && now - modelsCache.at < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }
  const models = parsePiListModels(await runListModels());
  modelsCache = { at: now, models };
  return models;
}

// Force a re-probe of `pi --list-models` — call after reconciling models.json
// (Phase 2) so a newly-added provider shows up without waiting out the TTL.
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

// --- Phase 2: endpoint management (reconcile + probe) ---

// Sidecar listing the provider ids Lattice manages in models.json, so a
// provider removed from the UI is precisely deleted from the file (while
// hand-written providers are never touched). Home-scoped, outside any project.
function managedProvidersSidecar(): string {
  return path.join(latticeHomeDir(), 'piManagedProviders.json');
}

// Shape one Lattice provider into the models.json provider object. Mirrors the
// known-good hand-written entry (input:['text'] + zero-cost block for a local
// endpoint) so Pi accepts it.
function buildModelsJsonProvider(p: PiProvider): Record<string, unknown> {
  return {
    baseUrl: p.baseUrl,
    api: p.api || 'openai-completions',
    // Pi REQUIRES an `apiKey` on any custom provider that defines models — if
    // it's missing, Pi rejects the ENTIRE models.json (so one keyless Lattice
    // provider would also knock out the user's hand-written ones). Local
    // servers (vLLM, …) don't check it, so default to a harmless placeholder
    // rather than emitting an invalid entry.
    apiKey: p.apiKey || 'local',
    ...(p.headers ? { headers: p.headers } : {}),
    ...(p.compat ? { compat: p.compat } : {}),
    models: p.models.map((m) => ({
      id: m.id,
      ...(m.name ? { name: m.name } : {}),
      ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
      input: ['text'],
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  };
}

// Reconcile globalSettings.piProviders INTO ~/.pi/agent/models.json: upsert
// every managed provider, delete managed providers the user removed, and
// preserve every hand-written provider. Atomic write (temp + rename). NEVER
// touches settings.json (no global-default pollution). Best-effort: logs and
// returns on any error. Call on boot + after a global-settings PATCH that
// carried piProviders.
export async function reconcilePiModelsJson(): Promise<void> {
  let providers: PiProvider[];
  try {
    providers = (await getGlobalSettings()).piProviders ?? [];
  } catch {
    return;
  }

  let prevManaged: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(managedProvidersSidecar(), 'utf8'));
    if (Array.isArray(parsed)) {
      prevManaged = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    /* no sidecar yet */
  }

  // Nothing to do and nothing was ever managed → don't create files.
  if (providers.length === 0 && prevManaged.length === 0) return;

  const file = path.join(piAgentDir(), 'models.json');
  let doc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (parsed && typeof parsed === 'object') doc = parsed as Record<string, unknown>;
  } catch {
    /* absent / corrupt → start fresh, preserving nothing we can't read */
  }
  const existing =
    doc.providers && typeof doc.providers === 'object'
      ? (doc.providers as Record<string, unknown>)
      : {};

  const desiredIds = new Set(providers.map((p) => p.id));
  // Remove providers Lattice managed before but the user has since deleted.
  for (const id of prevManaged) {
    if (!desiredIds.has(id)) delete existing[id];
  }
  // Upsert the managed providers (Lattice owns these ids). Preserve advanced
  // fields the endpoint form doesn't capture (e.g. a `compat.thinkingFormat`
  // hint, custom `headers`) when re-managing an id that already had them — so
  // taking a hand-tuned provider under UI management never silently drops them.
  for (const p of providers) {
    const built = buildModelsJsonProvider(p);
    const prev = existing[p.id];
    if (prev && typeof prev === 'object') {
      const pv = prev as Record<string, unknown>;
      if (built.compat === undefined && pv.compat) built.compat = pv.compat;
      if (built.headers === undefined && pv.headers) built.headers = pv.headers;
    }
    existing[p.id] = built;
  }
  doc.providers = existing;

  try {
    await fs.mkdir(piAgentDir(), { recursive: true });
    const tmp = `${file}.lattice.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8');
    await fs.rename(tmp, file);
    await fs.mkdir(latticeHomeDir(), { recursive: true });
    await fs.writeFile(
      managedProvidersSidecar(),
      JSON.stringify([...desiredIds], null, 2),
      'utf8',
    );
    console.log(
      `[pi-models] reconciled models.json: ${providers.length} managed provider(s) ` +
        `[${[...desiredIds].join(', ') || 'none'}]`,
    );
    resetPiModelsCache();
  } catch (err) {
    console.warn('[pi-models] reconcile failed:', err);
  }
}

const PROBE_TIMEOUT_MS = 8000;

// For a probe, resolve an apiKey hint to a literal bearer token: a `!command`
// is NOT executed (no arbitrary exec on a probe), an UPPER_SNAKE name that
// exists in the environment is read from there, otherwise it's treated as a
// literal. Local vLLM servers typically need no real key.
function resolveProbeKey(apiKey?: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.startsWith('!')) return undefined;
  if (/^[A-Z][A-Z0-9_]*$/.test(apiKey) && process.env[apiKey]) {
    return process.env[apiKey];
  }
  return apiKey;
}

// "Detect models" for the Settings → Pi endpoint form: GET <baseUrl>/models
// (OpenAI-compatible) and return the model ids. Throws on a non-OK response
// or network error so the route can surface it.
export async function probeEndpointModels(
  baseUrl: string,
  apiKey?: string,
): Promise<string[]> {
  const url = `${baseUrl.trim().replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    const key = resolveProbeKey(apiKey);
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetch(url, { headers, signal: controller.signal });
    if (!r.ok) throw new Error(`endpoint returned HTTP ${r.status}`);
    const j = (await r.json()) as { data?: Array<{ id?: unknown }> };
    return (j?.data ?? [])
      .map((m) => m?.id)
      .filter((x): x is string => typeof x === 'string' && !!x);
  } finally {
    clearTimeout(timer);
  }
}
