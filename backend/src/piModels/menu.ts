import type { ModelsJson, PiMenuEntry, PiModelInfo } from './types.js';

export function buildMenu(
  models: PiModelInfo[],
  modelsJson: ModelsJson | null,
  defaultPattern: string | null,
  curated: string[] | undefined,
  // Provider ids whose model list Lattice keeps in sync with the live endpoint
  // (globalSettings.piProviders + isAutoDiscoverEnabled). Their models bypass
  // curation — see the note where they're unioned in.
  autoProviders?: Set<string>,
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

  // Every model a models.json provider declares. This — not `pi --list-models`
  // — is the authority on what a managed endpoint offers: that CLI drops EVERY
  // custom provider if any one of them is malformed, and it reports nothing at
  // all when Pi has no usable auth, so building the default menu only from it
  // produced an empty dropdown for a perfectly good endpoint.
  const declared = [...nameByPattern.keys()];

  let patterns: string[];
  if (curated && curated.length > 0) {
    patterns = [...curated];
  } else {
    // Default: every model from a models.json-declared provider, plus Pi's
    // current default model. Keeps the dropdown to what the user configured.
    const set = new Set<string>(declared);
    for (const info of models) {
      if (customProviders.has(info.provider)) set.add(info.pattern);
    }
    if (defaultPattern) set.add(defaultPattern);
    patterns = [...set];
  }

  // An auto-discovering endpoint's models are eligible even against a CURATED
  // menu. The point of auto-discovery is that restarting a local server on a
  // different model makes that model selectable straight away; requiring the
  // user to go re-tick a curation checkbox for a model they never chose to hide
  // would put the manual step back exactly where it was removed.
  //
  // `autoProviders` deliberately EXCLUDES endpoints serving more models than
  // PI_MODELS_CONFIG.aggregatorModelCount (see discovery.ts). Bypassing
  // curation is right for the machine in the next room; for an aggregator
  // offering hundreds it would bury the dropdown, and there curation is the
  // whole point.
  if (autoProviders?.size) {
    for (const pattern of declared) {
      const provider = pattern.split('/')[0] ?? '';
      if (autoProviders.has(provider)) patterns.push(pattern);
    }
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
  return disambiguateLabels(entries);
}

// Two endpoints serving the same model id — a second vLLM box, a failover host,
// a big and a small machine running the same weights — otherwise produce two
// identical "Pi — qwen3.6-35b-a3b" rows, and picking one is a coin flip. Append
// the provider id to ONLY the labels that actually collide, so the ordinary
// single-endpoint menu stays clean. Mutates and returns the entries.
function disambiguateLabels(entries: PiMenuEntry[]): PiMenuEntry[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
  for (const e of entries) {
    if ((counts.get(e.label) ?? 0) > 1) {
      // The provider is the first segment; a model id may contain slashes of
      // its own (a HuggingFace repo id), so split off only the first.
      e.label = `${e.label} (${e.pattern.split('/')[0]})`;
    }
  }
  return entries;
}
