import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalProjectPath } from './projectPath.js';

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
    try {
      const raw = await fs.readFile(this.fileForProject(key), 'utf8');
      const parsed = this.deserialize(JSON.parse(raw), key);
      this.cache.set(key, parsed ?? this.defaultState(key));
    } catch {
      this.cache.set(key, this.defaultState(key));
    }
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
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
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
