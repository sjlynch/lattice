// Pi models.json RECONCILIATION for Lattice — the "sync managed providers into
// ~/.pi/agent/models.json" half of Pi endpoint management.
//
//   - reconcilePiModelsJson(): upsert globalSettings.piProviders INTO
//     ~/.pi/agent/models.json (preserving hand-written providers) so a custom
//     OpenAI-compatible endpoint (vLLM, …) becomes selectable.
//
// The endpoint-probe half ("Detect models") lives in ./probe.ts. Read-only
// DISCOVERY (pi --list-models parsing, menu curation) lives in ./discovery.ts;
// reconcile invalidates that module's cache via resetPiModelsCache so a
// newly-added provider shows up immediately.

import fs from 'node:fs/promises';
import path from 'node:path';
import { latticeHomeDir } from '../projectPath.js';
import { getGlobalSettings, type PiProvider } from '../globalSettings.js';
import { piAgentDir } from './config.js';
import { resetPiModelsCache } from './discovery.js';

// Sidecar listing the provider ids Lattice manages in models.json, so a
// provider removed from the UI is precisely deleted from the file (while
// hand-written providers are never touched). Home-scoped, outside any project.
function managedProvidersSidecar(): string {
  return path.join(latticeHomeDir(), 'piManagedProviders.json');
}

// Result of reading the existing models.json before reconciling into it.
//   - ok:true  → safe to proceed. `doc` is the parsed object to merge into, or
//     `{}` when the file is genuinely ABSENT (ENOENT) so it's fine to create.
//   - ok:false → the file EXISTS but couldn't be read or parsed (a transient
//     EBUSY/EPERM lock during boot, or lenient JSON — comments / trailing
//     commas / BOM — that Node's JSON.parse rejects even though Pi tolerates
//     it). The caller MUST abort without writing so hand-written providers are
//     never clobbered by a transient failure.
export type ReadModelsJsonResult =
  | { ok: true; doc: Record<string, unknown> }
  | { ok: false };

// Read (and parse) the existing ~/.pi/agent/models.json. The key distinction
// that prevents silent data loss: ONLY a genuinely-absent file (ENOENT) starts
// fresh; any other read error or a parse failure on existing content aborts the
// reconcile so we never overwrite a file we couldn't fully read.
export async function readExistingModelsJson(
  file: string,
): Promise<ReadModelsJsonResult> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Genuinely absent → safe to create a fresh file.
      return { ok: true, doc: {} };
    }
    // Any other read error (EBUSY/EPERM transient lock, EACCES, …): the file
    // likely exists and may hold hand-written providers. Abort — don't clobber.
    console.warn(`[pi-models] reconcile aborted — could not read ${file}:`, err);
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // File exists but isn't strict JSON. Abort rather than replace from scratch.
    console.warn(
      `[pi-models] reconcile aborted — ${file} exists but is not valid JSON ` +
        `(refusing to overwrite it):`,
      err,
    );
    return { ok: false };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, doc: parsed as Record<string, unknown> };
  }
  // Parsed, but to something that isn't a JSON object (array / null / scalar).
  // It's not a usable models.json, but it IS existing content — don't destroy it.
  console.warn(
    `[pi-models] reconcile aborted — ${file} is not a JSON object ` +
      `(refusing to overwrite it)`,
  );
  return { ok: false };
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

  // Defend against duplicate managed ids reaching the upsert (getGlobalSettings
  // already de-dupes, but a hand-edited globalSettings.json could bypass it):
  // models.json's `providers` map is keyed by id, so a later duplicate would
  // silently clobber the earlier one. Keep the first occurrence of each id.
  const seenIds = new Set<string>();
  providers = providers.filter((p) => {
    if (seenIds.has(p.id)) return false;
    seenIds.add(p.id);
    return true;
  });

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
  // Read the existing file. A non-ENOENT read error or a parse failure on
  // EXISTING content aborts here (returns ok:false) rather than starting fresh,
  // so a transient lock or a lenient-JSON models.json never causes us to
  // overwrite the file and silently drop the user's hand-written providers.
  const read = await readExistingModelsJson(file);
  if (!read.ok) return;
  const doc = read.doc;
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
