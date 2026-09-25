import { startTscWatch } from './tscWatch.mjs';
export const COMPILER_RETRY_DELAYS_MS: number[];
export const COMPILER_STABLE_MS: number;
export function createCompilerLifecycle(options: {
  tscBin: string;
  startWatch?: typeof startTscWatch;
  onCompileSucceeded?: () => void;
  now?: () => number;
  retryDelays?: number[];
  stableMs?: number;
  schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
  record?: (label: string, code: number, options: { expected: boolean; detail: string }) => unknown;
}): {
  start(): void;
  stop(signal?: NodeJS.Signals): void;
  // Replace the running (or paused) compiler with a fresh one; false if stopped
  // or the old one could not be killed.
  restart(reason: string): boolean;
  canRestartBackend(): boolean;
};
