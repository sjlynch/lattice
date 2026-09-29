import type { PiModelInfo, PiProbeModel, PiProvider } from '../../../api';

// Apply a "Detect models" probe result to the endpoint it was started for.
// The probe is async, so the target is found by the endpoint's id at APPLY
// time, not by the row index captured at click time: removing an earlier
// endpoint while the probe is in flight shifts every later row down one, and
// an index-addressed write then replaced a DIFFERENT endpoint's model list.
// An endpoint that was removed (or renamed) meanwhile gets nothing — `cur` is
// returned as-is. The optional predicate additionally fences the row instance
// and request configuration, so a reused id cannot inherit an old result.
// Keeps any per-model fields already saved for a model that
// survived, but a context window the server advertised WINS over a stored one:
// a re-detect is the user asking what this endpoint serves now, and a stale
// window (a server restarted with a different `--max-model-len`) is exactly
// what makes Pi mis-size its budget.
export function applyDetectedModels(
  cur: PiProvider[],
  endpointId: string,
  probed: PiProbeModel[],
  matchesRequest: (provider: PiProvider) => boolean = () => true,
): PiProvider[] {
  const idx = cur.findIndex((p) => p.id === endpointId && matchesRequest(p));
  if (idx === -1) return cur;
  return cur.map((p, i) =>
    i === idx
      ? {
          ...p,
          models: probed.map((pm) => ({
            ...(p.models.find((m) => m.id === pm.id) ?? { id: pm.id }),
            ...(pm.contextWindow === undefined
              ? {}
              : { contextWindow: pm.contextWindow }),
          })),
        }
      : p,
  );
}

// The universe of selectable model patterns = saved models ∪ everything the
// draft endpoints declare (`<providerId>/<modelId>` for each complete pair).
export function collectModelUniverse(
  savedModels: PiModelInfo[],
  providers: PiProvider[],
): Set<string> {
  const universe = new Set<string>(savedModels.map((m) => m.pattern));
  for (const p of providers) {
    for (const m of p.models) {
      if (p.id && m.id) universe.add(`${p.id}/${m.id}`);
    }
  }
  return universe;
}

// Above this many models an endpoint is an AGGREGATOR: its models no longer
// bypass menu curation and are picked by hand instead. Mirrors the backend's
// PI_MODELS_CONFIG.aggregatorModelCount — keep the two in step.
export const AGGREGATOR_MODEL_COUNT = 5;

// One row of an endpoint card's model checklist.
export type ShownEndpointModel = {
  id: string;
  contextWindow?: number;
  // Extended thinking levels this model accepts (xhigh / max), if any.
  thinkingLevels?: string[];
};

// The models to list for an endpoint: everything the last probe returned plus
// everything already saved on the provider (so a saved endpoint shows its
// models before you press "Detect"), each carrying the best context window
// known for it. A freshly-probed window wins over a saved one — the server is
// the authority on what it currently serves.
export function shownEndpointModels(
  endpoint: PiProvider,
  detected: PiProbeModel[],
): ShownEndpointModel[] {
  const ctx = new Map<string, number>();
  for (const m of endpoint.models) {
    if (m.contextWindow) ctx.set(m.id, m.contextWindow);
  }
  for (const m of detected) {
    if (m.contextWindow) ctx.set(m.id, m.contextWindow);
  }
  const ids = [
    ...new Set([
      ...detected.map((m) => m.id),
      ...endpoint.models.map((m) => m.id),
    ]),
  ];
  const levels = new Map<string, string[]>();
  for (const m of endpoint.models) {
    if (m.thinkingLevels?.length) levels.set(m.id, m.thinkingLevels);
  }
  return ids.map((id) => {
    const row: ShownEndpointModel = { id };
    const contextWindow = ctx.get(id);
    if (contextWindow !== undefined) row.contextWindow = contextWindow;
    const thinkingLevels = levels.get(id);
    if (thinkingLevels) row.thinkingLevels = thinkingLevels;
    return row;
  });
}

// The extended levels worth showing on a model row — the ones Pi could not
// reach on its own. Everything through `high` is Pi's default.
export function extendedThinkingLevels(levels?: string[]): string[] {
  return (levels ?? []).filter((l) => l === 'xhigh' || l === 'max');
}

// An endpoint listing more models than a person picks from by hand. Its models
// are curated through the Pi model menu rather than surfaced wholesale.
export function isAggregatorEndpoint(endpoint: PiProvider): boolean {
  return endpoint.models.length > AGGREGATOR_MODEL_COUNT;
}

// Compact context-window badge for the model checklist ("262K ctx"). The exact
// token count rides in the row's tooltip.
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M ctx`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K ctx`;
  return `${tokens} ctx`;
}

// Patterns belonging to an endpoint that auto-discovers its models. The backend
// unions those into the harness dropdowns regardless of curation (see
// piModels/menu.ts), so the curation checklist must present them as fixed — a
// checkbox that silently does nothing is worse than no checkbox.
export function alwaysShownPatterns(
  providers: PiProvider[],
  patterns: string[],
): Set<string> {
  // Mirrors the backend: an aggregator's models do NOT bypass curation, so they
  // must not render as fixed here either.
  const auto = new Set(
    providers
      .filter((p) => p.autoDiscover !== false && !isAggregatorEndpoint(p))
      .map((p) => p.id),
  );
  // Provider is the FIRST segment; a model id may contain slashes of its own.
  return new Set(patterns.filter((p) => auto.has(p.split('/')[0] ?? '')));
}
