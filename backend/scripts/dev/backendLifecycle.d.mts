import type { spawn, StdioOptions } from 'node:child_process';

export const TERMINAL_PORT: number;
export const BACKEND_PORT: number;
export const BOOT_DEATH_WINDOW_MS: number;
export const CRASH_RESPAWN_DELAYS_MS: number[];
export const CRASH_STABLE_UPTIME_MS: number;
// Delay before crash-respawn attempt #attempt (0-based); past the list, the last.
export function crashRespawnDelayMs(attempt: number, delays?: number[]): number;
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
  // Crash auto-respawn backoff (defaults: CRASH_RESPAWN_DELAYS_MS /
  // CRASH_STABLE_UPTIME_MS) and injectable timers for tests.
  crashRespawnDelaysMs?: number[];
  crashStableUptimeMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): {
  start(): void;
  restartBackend(reason: string): boolean;
  kill(signal?: NodeJS.Signals): void;
  needsStart(): boolean;
  // True while an automatic respawn after a crash is scheduled.
  crashRespawnPending(): boolean;
};
export function shutdownTerminalServer(terminalPort?: number): Promise<void>;
