import type { ChildProcess, spawn } from 'node:child_process';

// Hand-written declarations for the orchestrator's child helpers, so the
// backend test suite gets types. Keep in sync with children.mjs.

export const KILL_GRACE_MS: number;

export function startChild(
  label: string,
  color: string,
  args: string[],
  options?: { filterViteProxy?: boolean; cwd?: string },
): ChildProcess;

// Resolves once the child has exited or the force-kill was issued. On win32
// it waits up to `graceMs` for the child's own exit before `taskkill /F /T`.
// Structural: a real ChildProcess, or a fake that exposes the same surface.
export interface KillableChild {
  pid?: number;
  killed: boolean;
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown;
  off(event: 'exit', listener: (...args: unknown[]) => void): unknown;
}

export function killTree(
  child: KillableChild | null | undefined,
  signal?: NodeJS.Signals,
  options?: { graceMs?: number; platform?: NodeJS.Platform; spawnProcess?: typeof spawn },
): Promise<void>;
