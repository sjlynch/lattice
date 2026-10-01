// One session per registry subscription, with a fresh identity even on
// A -> B -> A. Only this helper owns its counters and changed-id map.
export type RegistrySession = {
  readonly folder: string;
  captureGeneration: () => number;
  recordSnapshot: () => void;
  recordChangedId: (id: string) => void;
  changedIdsSince: (generation: number) => Set<string>;
  snapshotSupersedes: (generation: number) => boolean;
};

export function createRegistrySession(folder: string): RegistrySession {
  let generation = 0;
  let snapshotGeneration = 0;
  // Retain changes (including removals) for the subscription's lifetime.
  // A full snapshot advances its fence without clearing individual changes.
  const changedAt = new Map<string, number>();

  return {
    folder,
    captureGeneration(): number {
      return generation;
    },
    recordSnapshot(): void {
      snapshotGeneration = ++generation;
    },
    recordChangedId(id: string): void {
      changedAt.set(id, ++generation);
    },
    changedIdsSince(capturedGeneration: number): Set<string> {
      return new Set([...changedAt].filter(([, at]) => at > capturedGeneration).map(([id]) => id));
    },
    snapshotSupersedes(capturedGeneration: number): boolean {
      return snapshotGeneration > capturedGeneration;
    },
  };
}
