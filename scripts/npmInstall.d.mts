import type { spawn } from 'node:child_process';

// Hand-written declarations for the `npm install` runner, so TS consumers
// (the backend __tests__ suite) get types for it. depsWatch.d.mts re-exports
// these. Keep in sync with npmInstall.mjs.

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
