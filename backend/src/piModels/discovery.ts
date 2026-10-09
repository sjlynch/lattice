// Pi model DISCOVERY for Lattice's harness selectors. `pi --list-models` (Pi's
// built-in OAuth catalog PLUS custom providers declared in
// `~/.pi/agent/models.json`) is the non-hardcoded source: a provider added to
// models.json appears here with zero Lattice code changes.
//
// Exposed over GET /api/pi-models:
//   - `models`: the full parsed list.
//   - `menu`:   the curated subset shown as "Pi — X" rows in the harness
//               dropdowns. Uncurated (no globalSettings.piModelMenu), it defaults
//               to every model from a models.json-declared provider plus Pi's
//               current default model — what the user actually configured, not
//               every built-in entry.
//
// Read-only: discovery never writes Pi config. Model SELECTION is per-spawn via
// `--model` (worktree/commands.ts buildPiModelFlag); Pi's global defaults in
// ~/.pi/agent/settings.json are never touched. Endpoint MANAGEMENT (reconcile +
// probe, which DO write models.json) lives in ./reconcile.ts and ./probe.ts.
//
// Stable public facade for the read-only side; the focused modules behind it
// keep the historical exports from ./discovery.js and ../piModels.js working.

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
