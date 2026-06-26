import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from './projectPath.js';
import { atomicWriteFile } from './claudeTrust/configFile.js';
import { runExclusive } from './serializeWrites.js';

export type ProjectStateSubscriber<TState> = (
  projectPath: string,
  state: TState,
) => void;

export type ProjectStateManagerOptions<TState> = {
  name: string;
  fileForProject: (projectPath: string) => string;
  defaultState: (projectPath: string) => TState;
  deserialize?: (raw: unknown, projectPath: string) => TState | null;
  snapshot?: (state: TState) => TState;
  persistDelayMs?: number;
};

// Where a cross-project by-id lookup found an item: the project key whose
// cached list holds it, the list, the index within it, and the item itself.
// Used by list-backed subclasses (tasks, workflows) whose TState is an item
// array; see findInCacheById / withItemAcrossProjects.
export type ProjectItemLookup<TItem> = {
  project: string;
  list: TItem[];
  idx: number;
  item: TItem;
};

// Shared per-project state primitive: a canonical-project-keyed in-memory
// cache, lazy disk bootstrap, debounced JSON persistence, and subscriber
// bookkeeping. Domain modules keep ownership of validation/update semantics;
// this class only centralizes the repeated storage mechanics.
export class ProjectStateManager<
  TState,
  TSubscriber extends (...args: any[]) => void = ProjectStateSubscriber<TState>,
> {
  protected readonly cache = new Map<string, TState>();
  protected readonly loaded = new Map<string, boolean>();
  protected readonly loadPromises = new Map<string, Promise<string>>();
  protected readonly persistTimers = new Map<string, NodeJS.Timeout>();
  protected readonly listeners = new Set<TSubscriber>();
  // Project keys whose on-disk file was found corrupt at load AND could not be
  // preserved to a `.corrupt-*` sidecar. While a key is in here, writeStateNow
  // refuses to overwrite it — losing the still-recoverable bytes is the exact
  // silent-data-loss this class guards against. Normal corruption is preserved
  // (moved aside) so the key never lands here; this is the can't-even-preserve
  // last resort. Cleared only by a restart (after manual recovery).
  private readonly unpreservedCorruptKeys = new Set<string>();

  private readonly name: string;
  private readonly fileForProject: (projectPath: string) => string;
  private readonly defaultState: (projectPath: string) => TState;
  private readonly deserialize: (raw: unknown, projectPath: string) => TState | null;
  private readonly snapshot: (state: TState) => TState;
  private readonly persistDelayMs: number;

  constructor(options: ProjectStateManagerOptions<TState>) {
    this.name = options.name;
    this.fileForProject = options.fileForProject;
    this.defaultState = options.defaultState;
    this.deserialize = options.deserialize ?? ((raw) => raw as TState);
    this.snapshot = options.snapshot ?? ((state) => state);
    this.persistDelayMs = options.persistDelayMs ?? 100;
  }

  protected canonicalize(projectPath: string): string {
    return canonicalProjectPath(projectPath);
  }

  protected isLoaded(projectPath: string): boolean {
    return !!this.loaded.get(this.canonicalize(projectPath));
  }

  protected async loadIfNeeded(projectPath: string): Promise<string> {
    const key = this.canonicalize(projectPath);
    if (this.loaded.get(key)) return key;
    // Cache the in-flight load PROMISE, not a boolean. A second caller
    // arriving during the `await fs.readFile` below must wait for the same
    // load and see the populated cache — flipping `loaded` true *before* the
    // read resolved let a concurrent reader fall through to an empty cache
    // (transient empty board / task-not-found). `loaded` is only set once
    // the read has actually filled the cache.
    const inFlight = this.loadPromises.get(key);
    if (inFlight) return inFlight;
    const promise = this.performLoad(key);
    this.loadPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      this.loadPromises.delete(key);
    }
  }

  private async performLoad(key: string): Promise<string> {
    const file = this.fileForProject(key);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (e) {
      // ENOENT is the normal "new/empty project" case → default state. Any
      // other read error (EACCES/EIO/…) is rare; we can't read the bytes to
      // preserve them, so log and fall back to default rather than break the
      // read path. Crucially, we ONLY reach the default for a genuinely-missing
      // (or unreadable) file — never for a file that exists but won't parse.
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[${this.name}] failed to read ${file}:`, e);
      }
      this.cache.set(key, this.defaultState(key));
      this.loaded.set(key, true);
      return key;
    }
    try {
      const parsed = this.deserialize(JSON.parse(raw), key);
      this.cache.set(key, parsed ?? this.defaultState(key));
    } catch (parseErr) {
      // The file EXISTS but won't parse — a truncated/corrupt DB, almost always
      // a crash/power-loss landing mid-write (the debounced persist fires
      // constantly and the dev backend is frequently killed by tsc -w). Do NOT
      // silently treat this as an empty board: the next persist of any kind
      // would then overwrite the still-recoverable bytes with the default,
      // making the loss permanent and silent. Move the bad file aside to a
      // `.corrupt-<ts>` sidecar first, then continue with default state so the
      // app stays usable — the data is recoverable from the sidecar.
      await this.preserveCorruptFile(key, file, raw, parseErr);
      this.cache.set(key, this.defaultState(key));
    }
    this.loaded.set(key, true);
    return key;
  }

  // Move a corrupt/truncated state file aside to a `.corrupt-<ts>` sidecar so a
  // subsequent write can't clobber its still-recoverable bytes. Rename first
  // (also clears the bad file so a later load won't re-trip on it); fall back to
  // a copy if rename fails (locked / cross-device). If the bytes can't be
  // preserved at all, write-protect the key (writeStateNow then refuses to
  // overwrite) — preserving the data wins over keeping the board writable.
  private async preserveCorruptFile(
    key: string,
    file: string,
    raw: string,
    err: unknown,
  ): Promise<void> {
    const corruptPath = `${file}.corrupt-${Date.now()}`;
    const detail = err instanceof Error ? err.message : String(err);
    try {
      try {
        await fs.rename(file, corruptPath);
      } catch {
        await fs.writeFile(corruptPath, raw, 'utf8');
      }
      console.error(
        `[${this.name}] ${file} is corrupt/truncated (${detail}). Preserved the ` +
          `original at ${corruptPath} and loaded an empty state — the data was ` +
          `NOT discarded; recover it from the .corrupt-* file.`,
      );
    } catch (preserveErr) {
      this.unpreservedCorruptKeys.add(key);
      console.error(
        `[${this.name}] ${file} is corrupt and could NOT be preserved; refusing ` +
          `to overwrite it so the recoverable bytes survive. Recover it manually. ` +
          `Preservation error:`,
        preserveErr,
      );
    }
  }

  protected getCached(projectPath: string): TState | undefined {
    return this.cache.get(this.canonicalize(projectPath));
  }

  protected setCached(projectPath: string, state: TState): void {
    this.cache.set(this.canonicalize(projectPath), state);
  }

  protected cacheEntries(): IterableIterator<[string, TState]> {
    return this.cache.entries();
  }

  protected cacheValues(): IterableIterator<TState> {
    return this.cache.values();
  }

  // Linear scan over every currently-loaded project's cached list for an item
  // whose id matches. Subclasses pass their own id accessor. Only meaningful
  // when TState is an item array (tasks, workflows); the cast is sound under
  // that contract and contained here so the typed call sites stay clean.
  protected findInCacheById<TItem>(
    id: string,
    getId: (item: TItem) => string,
  ): ProjectItemLookup<TItem> | null {
    for (const [project, state] of this.cacheEntries()) {
      const list = state as unknown as TItem[];
      const idx = list.findIndex((item) => getId(item) === id);
      if (idx !== -1) return { project, list, idx, item: list[idx] };
    }
    return null;
  }

  // Resolve an item by id regardless of whether its project is currently
  // loaded: try the in-memory cache, then run the injected load-all strategy
  // and try once more. The strategy is injected because subclasses bulk-load
  // differently (the task store migrates via ensureProjectLoaded; the workflow
  // store just loadIfNeeded's each known project). Returns null if the id is
  // present nowhere even after loading every known project.
  protected async withItemAcrossProjects<TItem, T>(
    id: string,
    getId: (item: TItem) => string,
    loadAllKnown: () => Promise<void>,
    fn: (lookup: ProjectItemLookup<TItem>) => T | Promise<T>,
  ): Promise<T | null> {
    const cached = this.findInCacheById(id, getId);
    if (cached) return fn(cached);
    await loadAllKnown();
    const loaded = this.findInCacheById(id, getId);
    if (loaded) return fn(loaded);
    return null;
  }

  protected async writeStateNow(projectPath: string, state: TState): Promise<void> {
    const key = this.canonicalize(projectPath);
    const file = this.fileForProject(key);
    if (this.unpreservedCorruptKeys.has(key)) {
      // We loaded a corrupt file we couldn't preserve; overwriting it would
      // destroy the only recoverable copy. Surface an error rather than do it.
      throw new Error(
        `[${this.name}] refusing to overwrite corrupt ${file}: its bytes could ` +
          `not be preserved at load; recover it manually first`,
      );
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Atomic temp→rename (reused from the ~/.claude.json writer): a crash/kill
    // mid-write can no longer truncate the live file — readers see either the
    // old complete file or the new complete file, never a half-written one.
    await atomicWriteFile(file, JSON.stringify(state, null, 2));
  }

  // In-process per-project write serialization. Every read-modify-write of a
  // project's cached state (create / update / delete / reorder / crash-safe
  // update) runs through this. Without it, a writer that yields the event loop
  // — the crash-safe disk-before-cache update awaits its disk write — lets a
  // concurrent writer's mutation be reverted when the first writer resumes and
  // setCached's a snapshot taken before the yield (and its cancelPendingPersist
  // even drops the sibling's scheduled flush). Keyed by store name + canonical
  // project, so the task DB and the workflow store never contend on one
  // another's lock. In-process scope matches our single-backend topology (same
  // as mergeLocks.ts / serializeWrites.ts).
  protected runProjectWrite<T>(
    projectPath: string,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const lockKey = `${this.name}:${this.canonicalize(projectPath)}`;
    return runExclusive(lockKey, async () => fn());
  }

  // Mutating sibling of withItemAcrossProjects (which is read-only and
  // unlocked): resolve an item's project by id (cache, then the injected
  // load-all-known fallback), then run `fn` under that project's write lock
  // with the item RE-FOUND in the live cache — never against a pre-lock
  // snapshot, so a sibling mutation that landed while we were waiting for the
  // lock isn't clobbered. Returns null if the id resolves to no project, or the
  // item vanished before the lock was acquired.
  protected async withLockedItemAcrossProjects<TItem, T>(
    id: string,
    getId: (item: TItem) => string,
    loadAllKnown: () => Promise<void>,
    fn: (lookup: ProjectItemLookup<TItem>) => T | Promise<T>,
  ): Promise<T | null> {
    let found = this.findInCacheById<TItem>(id, getId);
    if (!found) {
      await loadAllKnown();
      found = this.findInCacheById<TItem>(id, getId);
    }
    if (!found) return null;
    const project = found.project;
    return this.runProjectWrite<T | null>(project, () => {
      const list = this.cache.get(project) as unknown as TItem[] | undefined;
      if (!list) return null;
      const idx = list.findIndex((item) => getId(item) === id);
      if (idx === -1) return null;
      return fn({ project, list, idx, item: list[idx] });
    });
  }

  protected cancelPendingPersist(projectPath: string): void {
    const key = this.canonicalize(projectPath);
    const timer = this.persistTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.persistTimers.delete(key);
  }

  protected schedulePersist(projectPath: string): void {
    const key = this.canonicalize(projectPath);
    if (this.persistTimers.has(key)) return;
    this.persistTimers.set(
      key,
      setTimeout(async () => {
        this.persistTimers.delete(key);
        const state = this.cache.get(key) ?? this.defaultState(key);
        try {
          await this.writeStateNow(key, state);
        } catch (e) {
          console.error(`[${this.name}] persist failed for`, key, e);
        }
      }, this.persistDelayMs),
    );
  }

  public async flushPersist(projectPath: string): Promise<void> {
    const key = this.canonicalize(projectPath);
    this.cancelPendingPersist(key);
    const state = this.cache.get(key) ?? this.defaultState(key);
    try {
      await this.writeStateNow(key, state);
    } catch (e) {
      console.error(`[${this.name}] flushPersist failed for`, key, e);
    }
  }

  public subscribe(fn: TSubscriber): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  protected notifyProject(projectPath: string): void {
    const key = this.canonicalize(projectPath);
    const state = this.snapshot(this.cache.get(key) ?? this.defaultState(key));
    for (const fn of this.listeners) {
      try {
        (fn as unknown as ProjectStateSubscriber<TState>)(key, state);
      } catch (err) {
        console.error(`[${this.name}] subscriber threw (isolated):`, err);
      }
    }
  }

  // Per-listener isolation. notify() / emitToSubscribers is called inline
  // from worker code (e.g. mergeRun finishRun, dispatchStep) — if a single
  // subscriber throws, the exception used to bubble up and break the
  // caller's control flow (errored workflow run, aborted merge worker,
  // etc.). A WS race that hits `ws.send` between the `readyState` check
  // and the send is the realistic source. Per-listener try/catch breaks
  // that cascade.
  protected emitToSubscribers(invoke: (fn: TSubscriber) => void): void {
    for (const fn of this.listeners) {
      try {
        invoke(fn);
      } catch (err) {
        console.error(`[${this.name}] subscriber threw (isolated):`, err);
      }
    }
  }
}
