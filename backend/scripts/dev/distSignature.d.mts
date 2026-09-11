// Hand-written declarations for the dev-runner's dist/ change verifier, so TS
// consumers (the __tests__ suite) get types for its pure helpers.
// Keep in sync with distSignature.mjs.

// Newest mtime (ms) under `dir`, folding in directory mtimes so a create or
// delete counts. `null` means the tree could not be read — callers must treat
// that as "unknown" and fail OPEN, never as 0.
export function newestDistMtimeMs(dir?: string): number | null;
export function distContentSignature(dir?: string): string | null;

export function shouldRestartForDist(args: {
  newest: number | null | undefined;
  baseline: number | null | undefined;
}): boolean;

export function describeDistEvent(
  eventType?: string | null,
  filename?: string | null,
): string;
