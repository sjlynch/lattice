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
// Read-only: discovery never writes Pi config. Model SELECTION happens
// per-spawn via the `--model` flag (see worktree/commands.ts buildPiModelFlag);
// Pi's global defaults in ~/.pi/agent/settings.json are never touched. Endpoint
// MANAGEMENT (reconcile + probe, which DO write models.json) lives in
// ./reconcile.ts and ./probe.ts.
//
// This file is the stable public facade for the read-only side. The focused
// implementation modules keep parsing/cache/file-reading/menu curation separate
// while preserving historical exports from ./discovery.js and ../piModels.js.

import { getGlobalSettings } from '../globalSettings.js';
import { PI_MODELS_CONFIG } from './config.js';
import { isAutoDiscoverEnabled } from '../piProviderValidation.js';
import { getUserSettings } from '../userSettings.js';
import { normalizePiModel } from '../worktree/commands.js';
import { readDefaultPattern, readModelsJson } from './files.js';
import { loadModels } from './listModels.js';
import { buildMenu } from './menu.js';
import type { PiProvider } from '../piProviderValidation.js';
import type { PiModelsResult } from './types.js';

export { normalizePiModel } from '../worktree/commands.js';
export { resetPiModelsCache } from './listModels.js';
export { parsePiListModels, reconcileModelsCache } from './parser.js';
export type { PiMenuEntry, PiModelInfo, PiModelsResult } from './types.js';

// The full picture for the harness dropdowns. `curated` comes from
// globalSettings.piModelMenu (empty/undefined → the default menu above).
export async function getPiModels(curated?: string[]): Promise<PiModelsResult> {
  const [models, modelsJson, defaultPattern, global] = await Promise.all([
    loadModels(),
    readModelsJson(),
    readDefaultPattern(),
    getGlobalSettings().catch(() => ({ piProviders: [] as PiProvider[] })),
  ]);
  // Endpoints whose model list tracks the live server AND that serve few enough
  // models to surface wholesale — their models stay menu-eligible regardless of
  // curation (see buildMenu). An aggregator is excluded: you pick from those.
  const autoProviders = new Set(
    (global.piProviders ?? [])
      .filter(
        (p) =>
          isAutoDiscoverEnabled(p) &&
          p.models.length <= PI_MODELS_CONFIG.aggregatorModelCount,
      )
      .map((p) => p.id),
  );
  return {
    models,
    menu: buildMenu(models, modelsJson, defaultPattern, curated, autoProviders),
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
