import type { ModelsJson, PiMenuEntry, PiModelInfo } from './types.js';

export function buildMenu(
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
