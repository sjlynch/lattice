import type { ChildProcess, spawn } from 'node:child_process';
export type CompileResult = { successful: boolean; errors: number };
export type TscWatchChild = ChildProcess & {
  tscSettledPromise: Promise<CompileResult | null>;
  captureTscOutputTail?: () => void;
};
export type TscWatchOptions = {
  polling?: boolean;
  onCompileStart?: () => void;
  onCompileComplete?: (result: CompileResult) => void;
  spawnProcess?: typeof spawn;
  cwd?: string;
  forwardOutput?: (text: string, stream: 'stdout' | 'stderr') => unknown;
  recordLine?: (line: string) => void;
};
export function tscWatchArgs(tscBin: string, polling?: boolean): string[];
export function startTscWatch(tscBin: string, options?: TscWatchOptions): TscWatchChild;
