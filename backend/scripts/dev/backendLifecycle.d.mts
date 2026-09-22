import type { spawn, StdioOptions } from 'node:child_process';

export const TERMINAL_PORT: number;
export const BACKEND_PORT: number;
export const BOOT_DEATH_WINDOW_MS: number;
// True when something accepts a TCP connection on 127.0.0.1:<port>.
export function probeBackendPort(port?: number, timeoutMs?: number): Promise<boolean>;
export function portHeldHint(port?: number, platform?: NodeJS.Platform): string;
export function createBackendLifecycle<Version = undefined>(options: {
  copyAssetsBeforeRespawn: () => void;
  isShuttingDown: () => boolean;
  onExitDuringShutdown: (code: number) => void | Promise<void>;
  stdio?: StdioOptions;
  spawnProcess?: typeof spawn;
  canSpawnBackend?: () => boolean;
  captureBackendVersion?: () => Version;
  onBackendSpawned?: (version: Version) => void;
  // Injected for tests: whether the backend port is held after a boot death.
  probePort?: (port: number) => Promise<boolean>;
  now?: () => number;
}): {
  start(): void;
  restartBackend(reason: string): boolean;
  kill(signal?: NodeJS.Signals): void;
  needsStart(): boolean;
};
export function shutdownTerminalServer(terminalPort?: number): Promise<void>;
