// A pty size is a positive integer; anything else (NaN, 0, a float, a huge
// negative from a mangled query) is ignored rather than handed to node-pty.
// Same predicate the backend's POST /api/terminals applies to its body. Capped
// at ConPTY's signed 16-bit COORD limit — a larger size misbehaves on Windows.
//
// Dependency-free on purpose: the main backend's routes import it, and must
// not pull `attach.ts` (→ createSession → node-pty) into that process.
export const MAX_PTY_DIMENSION = 32767;
export function isPtyDimension(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_PTY_DIMENSION;
}
