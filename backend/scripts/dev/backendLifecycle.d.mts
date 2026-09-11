import type { spawn, StdioOptions } from 'node:child_process';

export const TERMINAL_PORT: number;
export function createBackendLifecycle<Version = undefined>(options: {
  copyAssetsBeforeRespawn: () => void;
  isShuttingDown: () => boolean;
  onExitDuringShutdown: (code: number) => void | Promise<void>;
  stdio?: StdioOptions;
  spawnProcess?: typeof spawn;
  canSpawnBackend?: () => boolean;
  captureBackendVersion?: () => Version;
  onBackendSpawned?: (version: Version) => void;
}): {
  start(): void;
  restartBackend(reason: string): boolean;
  kill(signal?: NodeJS.Signals): void;
  needsStart(): boolean;
};
export function shutdownTerminalServer(terminalPort?: number): Promise<void>;
