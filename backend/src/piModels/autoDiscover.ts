// Pi endpoint AUTO-DISCOVERY — keep each managed endpoint's model list in sync
// with what the server is actually serving, so adding a base URL is the only
// step required to get a working "Pi — X" row.
//
// Why this exists: the endpoint form used to require a manual "Detect models"
// click plus a checkbox per model. Skipping it saved a provider with
// `models: []`, which Pi reads as a provider that offers nothing — and since a
// custom provider is often the ONLY one configured, `pi --list-models` then
// reports no models at all and every Pi session falls back to nothing. A URL
// that silently produces a dead harness is the failure this module removes.
//
// Scope: only the models an endpoint is CURRENTLY serving are discoverable.
// `GET /v1/models` is the whole contract an OpenAI-compatible server offers —
// there is no standard way to enumerate weights that aren't loaded, nor to ask
// a server to load a different one. Single-model servers (NInfer, a plain vLLM
// process) therefore expose exactly the one model they were launched with, and
// swapping it means restarting the server; this module simply notices when that
// happened. Pi's own llama.cpp integration (`/llama`) is the exception that
// handles load/unload, and it is a llama.cpp-specific protocol, not this one.
//
// Read-then-write: probe every auto-discover provider, merge the result into
// `globalSettings.piProviders`, and let reconcile.ts push that into
// `~/.pi/agent/models.json`. Failure is always non-destructive — a server that
// is down or briefly unreachable leaves the last known-good model list in
// place, because blanking it is what breaks Pi.

import { getGlobalSettings, updateGlobalSettingsWith } from '../globalSettings.js';
import {
  isAutoDiscoverEnabled,
  type PiProvider,
  type PiProviderModel,
} from '../piProviderValidation.js';
import { PI_MODELS_CONFIG } from './config.js';
import { probeEndpointModels, probeThinkingLevels, type ProbedModel } from './probe.js';
import { extendsBeyondStandard } from './thinkingLevels.js';
import { reconcilePiModelsJson } from './reconcile.js';
import { createSweepScheduler } from './sweepScheduler.js';

// Re-exported so `piModels.js` consumers get the predicate alongside the rest
// of the auto-discovery surface; it is DEFINED next to the PiProvider type.
export { isAutoDiscoverEnabled };

// Fold a probe result into the stored models, keeping every per-model field the
// user set (friendly `name`, `reasoning`, `maxTokens`) for a model that is still
// served, and taking the server's context window as authoritative. The RESULT
// ORDER and membership come from the probe: a model the endpoint no longer
// serves drops out, which is the point of re-discovering.
export function mergeDiscoveredModels(
  stored: PiProviderModel[],
  probed: ProbedModel[],
): PiProviderModel[] {
  return probed.map((pm) => {
    const prev = stored.find((m) => m.id === pm.id);
    const merged: PiProviderModel = prev ? { ...prev } : { id: pm.id };
    if (pm.contextWindow !== undefined) merged.contextWindow = pm.contextWindow;
    return merged;
  });
}

// Decide one provider's next model list from its probe outcome.
//   - probe threw (server down / bad URL)  → `null`, keep what we have
//   - probe returned nothing               → keep what we have
//   - probe returned models                → merge them in
// The empty case is deliberately conservative: a reachable-but-empty listing is
// far more often a server mid-restart than a deliberate "I serve nothing now",
// and dropping the models would take Pi down with it until the next refresh.
export function nextModelsForProvider(
  provider: PiProvider,
  probed: ProbedModel[] | null,
): PiProviderModel[] {
  if (probed === null || probed.length === 0) return provider.models;
  return mergeDiscoveredModels(provider.models, probed);
}

// Which models still need a thinking-level capability probe: ones we have never
// probed (no `thinkingLevels` recorded). Skipped entirely past the limit — this
// is one request per model, fine for a handful and absurd for the ~450 an
// aggregator lists.
export function modelsNeedingThinkingProbe(
  models: PiProviderModel[],
  aggregatorModelCount: number,
): PiProviderModel[] {
  if (models.length > aggregatorModelCount) return [];
  return models.filter((m) => m.thinkingLevels === undefined);
}

// Record the probe result on a model. Only levels that reach BEYOND Pi's
// standard ceiling are stored: everything through `high` is already Pi's default
// behaviour, so writing a map for it would add config that changes nothing.
// A model that was probed and found ordinary gets an empty array — that is the
// "asked and answered" marker which stops us probing it again every sweep.
// Only ever called with a real answer: a probe that got NO answer (`null` from
// probeThinkingLevels) must not reach here, or a transiently-down server would
// be recorded as "ordinary" and have `xhigh`/`max` clamped for good.
export function applyThinkingLevels(
  model: PiProviderModel,
  tokens: string[],
): PiProviderModel {
  return {
    ...model,
    thinkingLevels: extendsBeyondStandard(tokens) ? tokens : [],
  };
}

// Probe one provider, converting any failure into `null` (the "keep what we
// have" signal) so one unreachable endpoint never aborts the whole refresh.
async function probeProvider(provider: PiProvider): Promise<ProbedModel[] | null> {
  try {
    return await probeEndpointModels(provider.baseUrl, provider.apiKey);
  } catch (err) {
    // Covers unreachable AND reachable-but-refusing (a 401 from an endpoint
    // whose apiKey is an env-var NAME, which probes deliberately do not
    // resolve), so don't claim the host is down.
    console.warn(
      `[pi-models] auto-discovery: could not list models from ${provider.id} ` +
        `(${provider.baseUrl}) — keeping its last known models:`,
      (err as Error).message,
    );
    return null;
  }
}

const scheduler = createSweepScheduler({
  sweep: () => runRefresh(),
  ttlMs: PI_MODELS_CONFIG.discoveryTtlMs,
  onError: (err) => console.warn('[pi-models] auto-discovery failed:', err),
});

// Re-probe every auto-discover endpoint and persist any change.
// Returns whether the stored provider list actually changed.
//
//   `force`     — the inputs just changed (boot, a settings save); never adopt
//                 a sweep that started before that change.
//   `maxWaitMs` — stop WAITING after this long; the sweep still finishes. Pass
//                 it on HTTP paths so a dead endpoint's probe timeout can't
//                 stall the response.
//
// See sweepScheduler.ts for why each rule is there.
export function refreshEndpointDiscovery(
  opts: { force?: boolean; maxWaitMs?: number } = {},
): Promise<boolean> {
  return scheduler.run(opts);
}

async function runRefresh(): Promise<boolean> {
  const providers = (await getGlobalSettings()).piProviders ?? [];
  const targets = providers.filter(
    (p) => isAutoDiscoverEnabled(p) && p.baseUrl.trim(),
  );
  if (targets.length === 0) return false;

  // EVERY probe runs against the snapshot read above — the model listing AND
  // the per-model capability probe — and the results are only APPLIED after
  // the re-read below. Remember which URL each result came FROM, so it can't
  // be applied to a provider that has since been pointed somewhere else.
  //
  // Capability detection, once per newly-seen model: ask each endpoint which
  // `reasoning_effort` values it accepts. This is what makes `xhigh` / `max`
  // reachable at all — Pi clamps them to `high` unless the model declares a
  // thinkingLevelMap, silently and with nothing in the output to say so. It is
  // done HERE, on the snapshot, rather than after the re-read: each probe can
  // take up to its full timeout, and a Settings save landing while it ran
  // used to be overwritten by the write that followed (the route waits the
  // in-flight sweep out, so that window is exactly where a second save lands).
  const probedById: ProbeResults = new Map();
  await Promise.all(
    targets.map(async (p) => {
      const models = await probeProvider(p);
      const thinking = new Map<string, string[] | null>();
      const pending = modelsNeedingThinkingProbe(
        nextModelsForProvider(p, models),
        PI_MODELS_CONFIG.thinkingProbeModelLimit,
      );
      await Promise.all(
        pending.map(async (m) => {
          thinking.set(m.id, await probeThinkingLevels(p.baseUrl, p.apiKey, m.id));
        }),
      );
      probedById.set(p.id, { baseUrl: p.baseUrl, models, thinking });
    }),
  );

  // Re-read before writing. Probing takes real time, and a Settings save can
  // land in the middle of it — writing back the list we read at the start would
  // silently undo the user's edit. Apply each result only where it still
  // belongs: same provider id, still auto-discovering, still the same baseUrl.
  // NOTHING may be awaited between this read and the write below — every
  // `await` in that gap is a window in which a save is lost.
  //
  // The re-read therefore happens INSIDE the global-settings write lock
  // (updateGlobalSettingsWith): reading first and then calling
  // updateGlobalSettings queued the write behind any in-progress save, and
  // then wrote this sweep's pre-save snapshot back over it — a deleted
  // endpoint came back, an edited apiKey/baseUrl reverted.
  let changed = false;
  let next: PiProvider[] = [];
  await updateGlobalSettingsWith((settings) => {
    const current = settings.piProviders ?? [];
    next = applyProbeResults(current, probedById);
    changed = JSON.stringify(next) !== JSON.stringify(current);
    // Persist only when the probe actually moved something — this runs on
    // every dropdown open and globalSettings.json should not churn.
    return changed ? { piProviders: next } : null;
  });
  if (changed) {
    const summary = next
      .filter((p) => probedById.has(p.id))
      .map((p) => `${p.id}=[${p.models.map((m) => m.id).join(', ')}]`)
      .join(' ');
    console.log(`[pi-models] auto-discovery updated ${summary}`);
  }
  // Reconcile UNCONDITIONALLY, even when the probe changed nothing. models.json
  // drifts from globalSettings on its own — a settings save that landed while
  // the endpoint was unreachable, a hand edit, an older Lattice that wrote an
  // empty provider — and that drift is exactly the state where Pi has no model
  // to run. Gating the repair on "did the probe change anything" leaves the
  // broken file broken forever, since the probe keeps returning the same thing.
  // reconcilePiModelsJson() no-ops without writing when the file already
  // matches, so this is free in the common case.
  await reconcilePiModelsJson();
  return changed;
}

type ProbeResults = Map<
  string,
  { baseUrl: string; models: ProbedModel[] | null; thinking: Map<string, string[] | null> }
>;

// Apply a sweep's probe results to the CURRENT provider list: only where the
// result still belongs (same id, still auto-discovering, same baseUrl).
function applyProbeResults(current: PiProvider[], probedById: ProbeResults): PiProvider[] {
  return current.map((p) => {
    const hit = probedById.get(p.id);
    if (!hit || hit.baseUrl !== p.baseUrl || !isAutoDiscoverEnabled(p)) return p;
    const models = nextModelsForProvider(p, hit.models).map((m) => {
      // Still unprobed as far as the stored record knows, and the probe got a
      // real answer → record it. A `null` (no answer) leaves the model alone so
      // it is asked again next sweep instead of being marked "ordinary".
      if (m.thinkingLevels !== undefined) return m;
      const tokens = hit.thinking.get(m.id);
      return tokens == null ? m : applyThinkingLevels(m, tokens);
    });
    return { ...p, models };
  });
}

