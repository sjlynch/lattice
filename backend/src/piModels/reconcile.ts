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
import { atomicWriteFile } from '../claudeTrust/configFile.js';
import { runExclusive } from '../serializeWrites.js';
import { latticeHomeDir } from '../projectPath.js';
import { readGlobalSettingsStrict, type PiProvider } from '../globalSettings.js';
import { piAgentDir } from './config.js';
import { buildThinkingLevelMap } from './thinkingLevels.js';
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
// `raw` is the file's exact current text ('' when absent), so the caller can
// skip a no-op rewrite: reconcile now runs on every auto-discovery sweep, and
// rewriting an identical file would churn the disk and — worse — pointlessly
// invalidate the `pi --list-models` cache, forcing a fresh CLI spawn each time.
export type ReadModelsJsonResult =
  | { ok: true; doc: Record<string, unknown>; raw: string }
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
      return { ok: true, doc: {}, raw: '' };
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
    return { ok: true, doc: parsed as Record<string, unknown>, raw };
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
    models: p.models.map((m) => {
      // Detected effort tokens become Pi's thinkingLevelMap. A server that
      // enumerates them is a reasoning server, so `reasoning` follows from the
      // detection unless the stored model says otherwise — that pair is what
      // makes `xhigh` selectable instead of silently clamped to `high`.
      const levels = m.thinkingLevels;
      const detected = levels && levels.length > 0;
      return {
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoning !== undefined
          ? { reasoning: m.reasoning }
          : detected
            ? { reasoning: true }
            : {}),
        ...(detected ? { thinkingLevelMap: buildThinkingLevelMap(levels) } : {}),
        input: ['text'],
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    }),
  };
}

// Reconcile globalSettings.piProviders INTO ~/.pi/agent/models.json: upsert
// every managed provider, delete managed providers the user removed, and
// preserve every hand-written provider. Atomic write (temp + rename). NEVER
// touches settings.json (no global-default pollution). Best-effort: logs and
// returns on any error. Call on boot + after a global-settings PATCH that
// carried piProviders.
export function reconcilePiModelsJson(): Promise<void> {
  // SERIALIZED. Reconcile used to run only at boot and on a settings save, so
  // two calls overlapping was hard to arrange. It now also runs on every
  // auto-discovery sweep — i.e. whenever a harness dropdown opens — so a sweep's
  // reconcile and a save's reconcile really can interleave. Two writers racing
  // on models.json is how a user loses every hand-written provider at once, and
  // the read-then-write here is exactly the shape runExclusive exists for.
  return runExclusive(
    `piModelsJson:${path.join(piAgentDir(), 'models.json')}`,
    reconcileLocked,
  );
}

async function reconcileLocked(): Promise<void> {
  let providers: PiProvider[];
  try {
    // STRICT: the display read falls back to defaults (no providers) on an
    // unreadable/corrupt globalSettings.json, which here would delete every
    // managed provider from models.json — and with them any hand-tuned
    // compat/headers that only lived there. A missing file still reads as
    // defaults (a genuine "nothing managed").
    providers = (await readGlobalSettingsStrict()).piProviders ?? [];
  } catch (err) {
    console.warn(
      '[pi-models] reconcile skipped: globalSettings.json unreadable:',
      (err as Error).message,
    );
    return;
  }

  // Defend against duplicate managed ids reaching the upsert (the settings read
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
  // Upsert the managed providers (Lattice owns these ids). Absent advanced
  // fields preserve hand-written configuration on adoption; explicit empty maps
  // clear it. Persisted empty maps prevent later sweeps from restoring overrides.
  for (const p of providers) {
    const built = buildModelsJsonProvider(p);
    if (p.compat && Object.keys(p.compat).length === 0) delete built.compat;
    if (p.headers && Object.keys(p.headers).length === 0) delete built.headers;
    const prev = existing[p.id];
    if (prev && typeof prev === 'object') {
      const pv = prev as Record<string, unknown>;
      if (p.compat === undefined && pv.compat) built.compat = pv.compat;
      if (p.headers === undefined && pv.headers) built.headers = pv.headers;
    }
    existing[p.id] = built;
  }
  doc.providers = existing;

  // Nothing to do when the file already says exactly this and we manage exactly
  // these ids. Reconcile is called on every discovery sweep (i.e. whenever a
  // harness dropdown opens), so this guard is what keeps that free.
  const serialized = JSON.stringify(doc, null, 2);
  const sidecarUnchanged =
    prevManaged.length === desiredIds.size &&
    prevManaged.every((id) => desiredIds.has(id));
  if (serialized === read.raw && sidecarUnchanged) return;

  try {
    await fs.mkdir(piAgentDir(), { recursive: true });
    // The repo's shared writer rather than a hand-rolled temp→rename: it uses a
    // UNIQUE temp name (the old fixed `models.json.lattice.tmp` is unsafe once
    // two reconciles can overlap), cleans the temp up on failure, and retries
    // the rename through the transient Windows locks Pi takes — it re-reads
    // models.json every time `/model` is opened, and a plain rename over a file
    // another process has open throws EPERM/EBUSY there.
    await atomicWriteFile(file, serialized);
    await fs.mkdir(latticeHomeDir(), { recursive: true });
    await atomicWriteFile(
      managedProvidersSidecar(),
      JSON.stringify([...desiredIds], null, 2),
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
