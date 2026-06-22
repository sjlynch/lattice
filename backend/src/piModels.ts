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

  // Keep only patterns Pi still reports, dedupe, preserve order.
  const seen = new Set<string>();
  const entries: PiMenuEntry[] = [];
  for (const pattern of patterns) {
    if (seen.has(pattern) || !byPattern.has(pattern)) continue;
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
