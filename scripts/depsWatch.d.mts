import type { spawn } from 'node:child_process';
import type { StaleDep } from './depsCheck.mjs';

// Hand-written declarations for the post-boot dependency watcher, so TS
// consumers (the backend __tests__ suite) get types for it.
// Keep in sync with depsWatch.mjs.

export const DEPS_MANIFEST_FILES: string[];
export const DEPS_WATCH_DEBOUNCE_MS: number;
export const MAX_AUTO_INSTALL_FAILURES: number;

export function manifestSignature(
  dir: string,
  readFile?: (file: string, encoding: 'utf8') => string,
): string;
export function isManifestEvent(filename: string | Buffer | null | undefined): boolean;
export function planDepsAction(args: {
  staleCount: number;
  signature: string;
  failedSignature: string | null;
  force?: boolean;
  failures?: number;
}): 'in-step' | 'install' | 'skip-failed';
export function classifyInstallFailure(output: string | null | undefined): { locked: boolean; nodePty: boolean };
export function installFailureHint(
  failure: { locked: boolean; nodePty: boolean },
  platform?: NodeJS.Platform,
): string;

export interface InstallResult {
  code: number;
  output: string;
}
export interface InstallHandle {
  done: Promise<InstallResult>;
  kill(): void;
}
export function runNpmInstall(args: {
  cwd: string;
  recordLabel: string;
  forward?: (line: string, stream: 'stdout' | 'stderr') => void;
  spawnProcess?: typeof spawn;
  platform?: NodeJS.Platform;
}): InstallHandle;

export interface WatcherLike {
  close(): void;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

export interface DepsWatcher {
  start(): void;
  close(): void;
  recheck(options?: { force?: boolean }): Promise<void>;
  isInstalling(): boolean;
  settled(): Promise<void>;
}

export function createDepsWatcher(args: {
  dir: string;
  label: string;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  check?: (dir: string) => StaleDep[];
  signature?: (dir: string) => string;
  install?: (args: { recordLabel: string }) => InstallHandle;
  beforeInstall?: () => Promise<void> | void;
  afterInstall?: (result: { ok: boolean; code: number }) => Promise<void> | void;
  record?: (label: string, code: number, options: { detail: string }) => string | null | void;
  watch?: (dir: string, listener: (eventType: string, filename: string | null) => void) => WatcherLike;
  debounceMs?: number;
  platform?: NodeJS.Platform;
  schedule?: (callback: () => void, ms: number) => unknown;
  unschedule?: (timer: unknown) => void;
}): DepsWatcher;
