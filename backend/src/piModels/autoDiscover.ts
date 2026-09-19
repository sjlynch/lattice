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

import { getGlobalSettings, updateGlobalSettings } from '../globalSettings.js';
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

  // Remember which URL each result came FROM, so it can't be applied to a
  // provider that has since been pointed somewhere else.
  const probedById = new Map<string, { baseUrl: string; models: ProbedModel[] | null }>();
  await Promise.all(
    targets.map(async (p) => {
      probedById.set(p.id, { baseUrl: p.baseUrl, models: await probeProvider(p) });
    }),
  );

  // Re-read before writing. Probing takes real time, and a Settings save can
  // land in the middle of it — writing back the list we read at the start would
  // silently undo the user's edit. Apply each result only where it still
  // belongs: same provider id, still auto-discovering, still the same baseUrl.
  const current = (await getGlobalSettings()).piProviders ?? [];
  const synced: PiProvider[] = current.map((p) => {
    const hit = probedById.get(p.id);
    if (!hit || hit.baseUrl !== p.baseUrl || !isAutoDiscoverEnabled(p)) return p;
    return { ...p, models: nextModelsForProvider(p, hit.models) };
  });
  // Capability detection, once per newly-seen model: ask each endpoint which
  // `reasoning_effort` values it accepts. This is what makes `xhigh` / `max`
  // reachable at all — Pi clamps them to `high` unless the model declares a
  // thinkingLevelMap, silently and with nothing in the output to say so.
  const next = await Promise.all(
    synced.map(async (p) => {
      if (!probedById.has(p.id)) return p;
      const pending = modelsNeedingThinkingProbe(
        p.models,
        PI_MODELS_CONFIG.thinkingProbeModelLimit,
      );
      if (pending.length === 0) return p;
      const byId = new Map<string, string[]>();
      await Promise.all(
        pending.map(async (m) => {
          byId.set(m.id, await probeThinkingLevels(p.baseUrl, p.apiKey, m.id));
        }),
      );
      return {
        ...p,
        models: p.models.map((m) => {
          const tokens = byId.get(m.id);
          return tokens === undefined ? m : applyThinkingLevels(m, tokens);
        }),
      };
    }),
  );

  const changed = JSON.stringify(next) !== JSON.stringify(current);
  // Persist only when the probe actually moved something — this runs on every
  // dropdown open and globalSettings.json should not churn.
  if (changed) {
    await updateGlobalSettings({ piProviders: next });
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

