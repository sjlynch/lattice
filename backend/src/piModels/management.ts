// Pi endpoint MANAGEMENT for Lattice — the write side of Pi model config.
//
// Two operations back the Settings → Pi tab:
//   - reconcilePiModelsJson(): upsert globalSettings.piProviders INTO
//     ~/.pi/agent/models.json (preserving hand-written providers) so a custom
//     OpenAI-compatible endpoint (vLLM, …) becomes selectable.
//   - probeEndpointModels(): GET <baseUrl>/models for the "Detect models" button.
//
// Read-only DISCOVERY (pi --list-models parsing, menu curation) lives in
// ./discovery.ts; reconcile invalidates that module's cache via
// resetPiModelsCache so a newly-added provider shows up immediately.

import fs from 'node:fs/promises';
import path from 'node:path';
import { latticeHomeDir } from '../projectPath.js';
import { getGlobalSettings, type PiProvider } from '../globalSettings.js';
import { PI_MODELS_CONFIG, piAgentDir } from './config.js';
import { resetPiModelsCache } from './discovery.js';

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
  const timer = setTimeout(() => controller.abort(), PI_MODELS_CONFIG.probeTimeoutMs);
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
