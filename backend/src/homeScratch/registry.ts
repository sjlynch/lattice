// Tiny in-memory registry helper for one-off scratch-backed runs.
//
// Push runs and QA e2e runs have the same lifecycle shape: record a running
// run, mark it done from a Stop-hook callback (stamping doneAt), and forget it
// only after the frontend has observed completion. The important safety rule is
// shared too: a transient frontend poll/delete must never evict a still-running
// run, or the later Stop-hook callback loses the registry entry. Push also fans
// lifecycle events out to workflow waiters; QA keeps extra fields such as
// verdict/movedToDone directly on its run object. This helper owns only that
// common lifecycle shell.
//
// With a `store` (./persistence.ts) every change also rewrites the project's
// on-disk mirror of its RUNNING runs, so boot recovery
// (`../recovery/oneOffRunResume.ts`) can put a run whose agent survived a
// backend restart back into this map (`restore`) and its callbacks keep working.

import { canonicalProjectPath } from '../projectPath.js';
import type { OneOffRunStore } from './persistence.js';

export type OneOffRunBase = {
  id: string;
  projectPath: string;
  status: 'running' | 'done';
  doneAt?: number;
};

export type OneOffRunRegistryEvent<Run extends OneOffRunBase> =
  | { type: 'recorded'; run: Run }
  | { type: 'done'; run: Run }
  | { type: 'forgotten'; id: string; projectPath: string };

export type OneOffRunRegistryListener<Run extends OneOffRunBase> = (
  event: OneOffRunRegistryEvent<Run>,
) => void;

export type OneOffRunRegistry<Run extends OneOffRunBase> = {
  get(id: string): Run | undefined;
  record(run: Run): void;
  markDone(id: string): boolean;
  forget(id: string): void;
  subscribe(fn: OneOffRunRegistryListener<Run>): () => void;
  // Merge feature fields (a QA verdict, …) into a tracked run and re-mirror it.
  // Returns false for an unknown id.
  update(id: string, patch: Partial<Run>): boolean;
  // Boot recovery: put a persisted run back without emitting `recorded` (it is
  // not a new run). No-op (false) if the id is already tracked.
  restore(run: Run): boolean;
  // Every tracked run (clones), for recovery/tests.
  list(): Run[];
};

export function createOneOffRunRegistry<Run extends OneOffRunBase>(args: {
  logLabel: string;
  emitEvents?: boolean;
  store?: OneOffRunStore<Run>;
}): OneOffRunRegistry<Run> {
  const runs = new Map<string, Run>();
  const listeners = new Set<OneOffRunRegistryListener<Run>>();

  function cloneRun(run: Run): Run {
    return { ...run };
  }

  function sameProject(a: string, b: string): boolean {
    try {
      return canonicalProjectPath(a) === canonicalProjectPath(b);
    } catch {
      return a === b;
    }
  }

  // Re-mirror the project's still-running runs. Collected when the write
  // starts, so it always reflects the latest state.
  function persist(projectPath: string): void {
    if (!args.store || !projectPath) return;
    args.store.persist(projectPath, () =>
      [...runs.values()]
        .filter((r) => r.status === 'running' && sameProject(r.projectPath, projectPath))
        .map(cloneRun),
    );
  }

  function notify(event: OneOffRunRegistryEvent<Run>): void {
    if (!args.emitEvents) return;
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error(`${args.logLabel} listener threw:`, err);
      }
    }
  }

  return {
    get(id) {
      return runs.get(id);
    },

    record(run) {
      runs.set(run.id, run);
      persist(run.projectPath);
      notify({ type: 'recorded', run: cloneRun(run) });
    },

    markDone(id) {
      const run = runs.get(id);
      if (!run || run.status === 'done') return false;
      run.status = 'done';
      run.doneAt = Date.now();
      // Mirrored straight away: a restart before this lands would re-adopt a
      // finished run as `running`, and its `/done` has already been spent.
      persist(run.projectPath);
      notify({ type: 'done', run: cloneRun(run) });
      return true;
    },

    update(id, patch) {
      const run = runs.get(id);
      if (!run) return false;
      Object.assign(run, patch);
      persist(run.projectPath);
      return true;
    },

    restore(run) {
      if (runs.has(run.id)) return false;
      runs.set(run.id, cloneRun(run));
      return true;
    },

    list() {
      return [...runs.values()].map(cloneRun);
    },

    forget(id) {
      const existing = runs.get(id);
      // Never drop a still-running run. Frontend DELETEs are acknowledgements,
      // not authoritative cancellation signals; a transient poll failure must
      // not strand a later Stop-hook /done callback.
      if (existing && existing.status !== 'done') return;
      if (!runs.delete(id)) return;
      notify({
        type: 'forgotten',
        id,
        projectPath: existing?.projectPath ?? '',
      });
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
