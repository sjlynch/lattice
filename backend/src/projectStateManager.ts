import { canonicalProjectPath } from './projectPath.js';
import {
  findInCacheById as findListItemInCacheById,
  withItemAcrossProjectLists,
  withLockedItemAcrossProjectLists,
  type ProjectItemLookup,
} from './projectState/listLookup.js';
import {
  loadProjectStateFromDisk,
  writeProjectStateToDisk,
} from './projectState/diskPersistence.js';
import {
  flushAllProjectStatePersists,
  registerProjectStateStore,
} from './projectState/exitFlush.js';
import { PersistScheduler } from './projectState/persistScheduler.js';
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
  // Write any still-debounced state synchronously from a process `exit`
  // handler. Opt-in because the sync write bypasses `writeStateNow`, so only a
  // store that doesn't override it (its on-disk shape IS its cached state)
  // may enable it.
  flushOnExit?: boolean;
};

// Restart-drain flush of every store instance; see projectState/exitFlush.ts.
export { flushAllProjectStatePersists };

// Where a cross-project by-id lookup found an item: the project key whose
// cached list holds it, the list, the index within it, and the item itself.
// Used by list-backed subclasses (tasks, workflows) whose TState is an item
// array; see findInCacheById / withItemAcrossProjects.
export type { ProjectItemLookup };

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
  // Debounce + dirty-generation bookkeeping and the sync exit flush; shares
  // persistTimers (see projectState/persistScheduler.ts).
  private readonly persistScheduler: PersistScheduler<TState>;
  protected readonly listeners = new Set<TSubscriber>();
  // Project keys with a coalesced notifyProject fan-out scheduled (see there).
  private readonly pendingNotifies = new Set<string>();
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

  constructor(options: ProjectStateManagerOptions<TState>) {
    this.name = options.name;
    this.fileForProject = options.fileForProject;
    this.defaultState = options.defaultState;
    this.deserialize = options.deserialize ?? ((raw) => raw as TState);
    this.snapshot = options.snapshot ?? ((state) => state);
    this.persistScheduler = new PersistScheduler<TState>({
      name: this.name,
      persistDelayMs: options.persistDelayMs ?? 100,
      flushOnExit: options.flushOnExit ?? false,
      timers: this.persistTimers,
      fileForProject: (projectPath) => this.fileForProject(projectPath),
      latestState: (key) => this.cache.get(key) ?? this.defaultState(key),
      isWriteProtected: (projectKey) => this.unpreservedCorruptKeys.has(projectKey),
      runProjectWrite: (project, writeFn) => this.runProjectWrite(project, writeFn),
      writeStateNow: (projectPath, state) => this.writeStateNow(projectPath, state),
    });
    registerProjectStateStore(this);
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
    const state = await loadProjectStateFromDisk({
      name: this.name,
      key,
      file,
      defaultState: this.defaultState,
      deserialize: this.deserialize,
      markUnpreservedCorrupt: (projectPath) => {
        this.unpreservedCorruptKeys.add(projectPath);
      },
    });
    this.cache.set(key, state);
    this.loaded.set(key, true);
    return key;
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

  protected findInCacheById<TItem>(
    id: string,
    getId: (item: TItem) => string,
  ): ProjectItemLookup<TItem> | null {
    return findListItemInCacheById<TState, TItem>(
      this.cacheEntries(),
      id,
      getId,
    );
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
    return withItemAcrossProjectLists<TState, TItem, T>(
      () => this.cacheEntries(),
      id,
      getId,
      loadAllKnown,
      fn,
    );
  }

  protected async writeStateNow(projectPath: string, state: TState): Promise<void> {
    const key = this.canonicalize(projectPath);
    const file = this.fileForProject(key);
    await writeProjectStateToDisk({
      name: this.name,
      key,
      file,
      state,
      isWriteProtected: (projectKey) =>
        this.unpreservedCorruptKeys.has(projectKey),
    });
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
    return withLockedItemAcrossProjectLists<TState, TItem, T>({
      entries: () => this.cacheEntries(),
      getState: (project) => this.cache.get(project),
      runProjectWrite: (project, writeFn) => this.runProjectWrite(project, writeFn),
      id,
      getId,
      loadAllKnown,
      fn,
    });
  }

  protected cancelPendingPersist(projectPath: string): void {
    this.persistScheduler.cancel(this.canonicalize(projectPath));
  }

  // Synchronous last-chance write of every project mutated since its last
  // completed write, for the process `exit` handler; never throws. See
  // PersistScheduler.flushPendingPersistsSync.
  public flushPendingPersistsSync(): void {
    this.persistScheduler.flushPendingPersistsSync();
  }

  protected schedulePersist(projectPath: string): void {
    this.persistScheduler.schedule(this.canonicalize(projectPath));
  }

  public async flushPersist(projectPath: string): Promise<void> {
    const key = this.canonicalize(projectPath);
    this.cancelPendingPersist(key);
    try {
      await this.persistScheduler.persistLatest(key);
    } catch (e) {
      console.error(`[${this.name}] flushPersist failed for`, key, e);
    }
  }

  // Write every project mutated since its last completed write (debounce not
  // fired yet, write in flight, or an earlier write failed), and wait out any
  // write a timer already handed to the disk (every write runs under the
  // per-project write lock, so a no-op pass through it is that barrier).
  // Never rejects: flushPersist logs its own failures.
  public async flushAllPendingPersists(): Promise<void> {
    const pending = this.persistScheduler.pendingKeys();
    const keys = new Set([...this.cache.keys(), ...pending]);
    await Promise.all([...keys].map((key) => (pending.has(key)
      ? this.flushPersist(key)
      : this.runProjectWrite(key, () => undefined).catch(() => undefined))));
  }

  public subscribe(fn: TSubscriber): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  // Coalesced per project key: N mutations landing in one event-loop turn (a
  // bulk transition / bulk update / a merge run flipping tasks, each of which
  // calls notifyProject once PER task) produce ONE snapshot fan-out, taken
  // from the cache at flush time so it is always the latest state. Before this
  // every call serialized and pushed the whole board to every WS client —
  // 200 tasks moved meant 200 full-board frames per client. Subscribers are
  // therefore invoked asynchronously (setImmediate: after the current turn's
  // I/O callbacks + microtasks, which is where a `Promise.all` of updates
  // resolves); a test that inspects a subscriber right after an `await`ed
  // mutation must let a turn pass (`await flushProjectNotifications()`).
  protected notifyProject(projectPath: string): void {
    const key = this.canonicalize(projectPath);
    if (this.pendingNotifies.has(key)) return;
    this.pendingNotifies.add(key);
    setImmediate(() => {
      this.pendingNotifies.delete(key);
      this.notifyProjectNow(key);
    });
  }

  private notifyProjectNow(key: string): void {
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

// Await this after a mutation to observe its (coalesced, asynchronous)
// subscriber fan-out - mainly for tests.
export function flushProjectNotifications(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
