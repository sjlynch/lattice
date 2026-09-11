import type { spawn, StdioOptions } from 'node:child_process';

export const TERMINAL_PORT: number;
export function createBackendLifecycle(options: {
  copyAssetsBeforeRespawn: () => void;
  isShuttingDown: () => boolean;
  onExitDuringShutdown: (code: number) => void | Promise<void>;
  stdio?: StdioOptions;
  spawnProcess?: typeof spawn;
}): {
  start(): void;
  restartBackend(reason: string): boolean;
  kill(signal?: NodeJS.Signals): void;
};
export function shutdownTerminalServer(terminalPort?: number): Promise<void>;
