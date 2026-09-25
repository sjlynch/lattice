// Hand-written declarations for the dev runner's stop sequence.
// Keep in sync with devShutdown.mjs.

import type { PrepareResult } from './restartHandshake.mjs';

export function createDevShutdown(options: {
  stopWatchers: () => void;
  stopCompiler: (signal: NodeJS.Signals) => void;
  shutdownTerminals: () => Promise<void>;
  prepareDrain?: (reason: string) => Promise<PrepareResult>;
  killBackend: (signal: NodeJS.Signals) => void;
  needsBackendStart: () => boolean;
  onNoBackend: () => void | Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}): {
  shutdown(signal: NodeJS.Signals, options?: { keepTerminals?: boolean }): Promise<void>;
  isShuttingDown(): boolean;
  done(): Promise<void> | null;
};
