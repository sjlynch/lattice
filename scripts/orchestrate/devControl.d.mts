import type { Readable } from 'node:stream';

// Hand-written declarations for the dev console / dev-runner control helpers,
// so the backend test suite gets types. Keep in sync with devControl.mjs.

export const DEV_CONTROL_ENV: string;
export const DEV_CONTROL_STDIN: string;
export const SOFT_STOP: string;
export const DEPS_RECHECK: string;
export const RESTART_EXIT_CODE: number;
export const SOFT_STOP_TIMEOUT_MS: number;
export const CONSOLE_HINT: string;
export const CONSOLE_HELP: string[];

export type ConsoleCommand =
  | { kind: 'none' }
  | { kind: 'restart'; force: boolean }
  | { kind: 'detach'; force: boolean }
  | { kind: 'deps' }
  | { kind: 'help' }
  | { kind: 'unknown'; text: string };

export function parseConsoleCommand(line: string | null | undefined): ConsoleCommand;
export function relaunchAfterOrchestrator(code: number | null): 'relaunch' | 'exit';
export function afterPreflight(
  code: number | null,
  options: { softRestart: boolean },
): 'continue' | 'continue-degraded' | 'exit';
export function forwardedExitCode(code: number | null | undefined): number;
export function readLines(stream: Readable, onLine: (line: string) => void): void;

export interface ExitableChild {
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  once(event: 'exit', listener: (...args: unknown[]) => void): unknown;
  off(event: 'exit', listener: (...args: unknown[]) => void): unknown;
}
export function waitForExit(child: ExitableChild | null | undefined, timeoutMs: number): Promise<boolean>;
