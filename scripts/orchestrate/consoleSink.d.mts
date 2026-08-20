// Hand-written declarations for the dev orchestrator's non-blocking console
// sink, so TS consumers (the backend __tests__ suite) get types for it.
// Keep in sync with consoleSink.mjs.

/** A console sink over one fd: never blocks the event loop, bounded queue. */
export function createSink(fd: number): { write(text: string): void };

export const stdoutSink: { write(text: string): void };
export const stderrSink: { write(text: string): void };
