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
    this.loaded.set(key, true);
    try {
      const raw = await fs.readFile(this.fileForProject(key), 'utf8');
      const parsed = this.deserialize(JSON.parse(raw), key);
      this.cache.set(key, parsed ?? this.defaultState(key));
    } catch {
      this.cache.set(key, this.defaultState(key));
    }
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
