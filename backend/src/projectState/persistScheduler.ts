import { writeProjectStateToDiskSync } from './diskPersistence.js';
import { trackPendingPersist, untrackPendingPersist } from './exitFlush.js';

export type PersistSchedulerOptions<TState> = {
  name: string;
  persistDelayMs: number;
  flushOnExit: boolean;
  // The manager's `persistTimers` map, shared so subclasses still see which
  // debounces are pending.
  timers: Map<string, NodeJS.Timeout>;
  fileForProject: (projectPath: string) => string;
  // The key's cached state, or its default when nothing is cached.
  latestState: (key: string) => TState;
  isWriteProtected: (projectPath: string) => boolean;
  runProjectWrite: <TResult>(
    project: string,
    fn: () => TResult | Promise<TResult>,
  ) => Promise<TResult>;
  writeStateNow: (projectPath: string, state: TState) => Promise<void>;
};

// Debounced, dirty-generation-tracked persistence for one store. Keys are
// already canonical; the manager canonicalizes and supplies the (virtually
// dispatched) write lock and async writer as callbacks.
export class PersistScheduler<TState> {
  private readonly timers: Map<string, NodeJS.Timeout>;
  // Project keys whose cached state has changed since the last completed write
  // that captured it, mapped to the generation of their latest change. Set by
  // schedule; cleared only by a write whose snapshot was taken at that
  // generation (so a mutation landing mid-write keeps the key dirty). This —
  // not the timers — is what the exit flush writes: a fired timer deletes its
  // entry before its async write finishes.
  private readonly dirtyGenerations = new Map<string, number>();
  private nextDirtyGeneration = 0;

  constructor(private readonly options: PersistSchedulerOptions<TState>) {
    this.timers = options.timers;
  }

  // Keys with a debounce still pending or a mutation not yet durably written.
  public pendingKeys(): Set<string> {
    return new Set([...this.timers.keys(), ...this.dirtyGenerations.keys()]);
  }

  public cancel(key: string): void {
    const timer = this.timers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(key);
    this.untrackIfNoPendingPersist();
  }

  private untrackIfNoPendingPersist(): void {
    if (this.timers.size === 0 && this.dirtyGenerations.size === 0) {
      untrackPendingPersist(this);
    }
  }

  // Write the key's latest cached state under its write lock, then mark it
  // clean — unless it was mutated again after the snapshot was taken.
  public async persistLatest(key: string): Promise<void> {
    await this.options.runProjectWrite(key, async () => {
      const generation = this.dirtyGenerations.get(key);
      const state = this.options.latestState(key);
      await this.options.writeStateNow(key, state);
      if (generation !== undefined && this.dirtyGenerations.get(key) === generation) {
        this.dirtyGenerations.delete(key);
        this.untrackIfNoPendingPersist();
      }
    });
  }

  // Synchronous last-chance write of every project mutated since its last
  // completed write — debounce timer still pending OR write already in flight —
  // for the process `exit` handler (which cannot await). Honors the
  // corrupt-file write protection and stays temp→rename atomic; a failure is
  // logged and never thrown (an exit handler must not throw).
  public flushPendingPersistsSync(): void {
    const keys = this.pendingKeys();
    for (const key of keys) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
      try {
        writeProjectStateToDiskSync({
          name: this.options.name,
          key,
          file: this.options.fileForProject(key),
          state: this.options.latestState(key),
          isWriteProtected: this.options.isWriteProtected,
        });
        this.dirtyGenerations.delete(key);
      } catch (e) {
        console.error(`[${this.options.name}] exit flush failed for`, key, e);
      }
    }
    untrackPendingPersist(this);
  }

  public schedule(key: string): void {
    this.dirtyGenerations.set(key, ++this.nextDirtyGeneration);
    if (this.options.flushOnExit) {
      trackPendingPersist(this);
    }
    if (this.timers.has(key)) return;
    this.timers.set(
      key,
      setTimeout(async () => {
        this.timers.delete(key);
        this.untrackIfNoPendingPersist();
        try {
          // A fired timer is no longer cancellable by updateTaskCrashSafe.
          // Serialize the actual write with mutations, and take the snapshot
          // only after acquiring the lock so an older debounce cannot land
          // over a completed disk-before-cache merge transition.
          await this.persistLatest(key);
        } catch (e) {
          console.error(`[${this.options.name}] persist failed for`, key, e);
        }
      }, this.options.persistDelayMs),
    );
  }
}
