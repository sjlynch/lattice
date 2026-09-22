import type { Readable } from 'node:stream';

// Hand-written declarations for the orchestrator's output filter, so the
// backend test suite gets types. Keep in sync with logFilter.mjs.

// Does a (ANSI-stripped) line continue a vite proxy-error block?
export function isContinuation(plain: string): boolean;

export function prefixLines(
  stream: Readable,
  sink: { write(chunk: string): unknown },
  options: { label: string; color: string; filterViteProxy?: boolean },
): void;
