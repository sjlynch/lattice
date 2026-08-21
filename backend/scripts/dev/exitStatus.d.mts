// Hand-written declarations for the dev-runner's exit-code decoder, so TS
// consumers (the __tests__ suite) get types for its pure helpers.
// Keep in sync with exitStatus.mjs.

// True when the exit code is an OS-level fault (a Windows NTSTATUS) rather than
// an exit the process chose for itself.
export function isHardFault(code: number | null | undefined): boolean;

// One human-readable phrase for a child's cause of death. A signal wins; a
// Windows fault code is decoded to `code N = 0xC0000005 STATUS_… — why`;
// anything else renders as `code N`.
export function describeExitCode(
  code: number | null | undefined,
  signal?: string | null,
): string;
