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
};

export function createOneOffRunRegistry<Run extends OneOffRunBase>(args: {
  logLabel: string;
  emitEvents?: boolean;
}): OneOffRunRegistry<Run> {
  const runs = new Map<string, Run>();
  const listeners = new Set<OneOffRunRegistryListener<Run>>();

  function cloneRun(run: Run): Run {
    return { ...run };
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
      notify({ type: 'recorded', run: cloneRun(run) });
    },

    markDone(id) {
      const run = runs.get(id);
      if (!run || run.status === 'done') return false;
      run.status = 'done';
      run.doneAt = Date.now();
      notify({ type: 'done', run: cloneRun(run) });
      return true;
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
