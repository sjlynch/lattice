// Hand-written declarations for the per-policy compiled-output state.
// Keep in sync with restartOutputState.mjs.

export type RestartOutputBaseline = {
  mtime: number | null;
  content: string | null;
  compileSequence: number;
};

export function createRestartOutputState(args: {
  readNewestDistMtime: () => number | null;
  readDistContentSignature: () => string | null;
}): {
  captureDistBaseline(): RestartOutputBaseline;
  resetDistBaseline(): void;
  // For accepted restarts when the policy does not wait for an actual spawn.
  commitRestartBaseline(newestSeen: number | null | undefined): void;
  // Commit exactly the output captured before the child was spawned.
  commitSpawnBaseline(candidate: RestartOutputBaseline): void;
  // Unknown mtimes fail open, using the existing dist-signature decision.
  hasDistChange(newest: number | null): boolean;
  recordCompletedCompile(): string | null;
  // Exact content equality; null signatures remain unknown.
  isUnchangedCompile(current: string | null): boolean;
  resetMtimeBaseline(): void;
  needsCompileCatchUp(candidate: RestartOutputBaseline): boolean;
};
