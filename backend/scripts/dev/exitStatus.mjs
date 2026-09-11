// What actually killed a child process, in words.
//
// On Windows a process killed by a hard fault exits with its NTSTATUS AS the
// exit code, so the dev runner printed deaths like:
//
//   [lattice-backend] dist/index.js exited (code 3221225477)
//
// which reads like an ordinary non-zero exit. It is not. 3221225477 is
// 0xC0000005, STATUS_ACCESS_VIOLATION: the OS tore the process down for
// dereferencing a bad pointer. Nothing in `backend/src/crashLog.ts` can see
// that — a fault at that level runs no JavaScript, so the ring buffer, the
// crash file and Node's diagnostic report all produce nothing, and the raw
// number was the only evidence left. (Observed 2026-08-20: the backend died
// this way at the end of a merge run and left no artifact anywhere.)
//
// Decoding it is the difference between "the backend exited" and "the backend
// segfaulted, so stop looking for a JS bug".

// The statuses a Node process on Windows realistically dies from. Anything not
// listed still gets its hex rendered, which is enough to look up.
const NTSTATUS = new Map([
  [
    0xc0000005,
    [
      'STATUS_ACCESS_VIOLATION',
      'hard native crash — a bad pointer dereference inside V8, libuv or a native module. No JS runs on the way out, so no crash file or diagnostic report is written.',
    ],
  ],
  [
    0xc00000fd,
    ['STATUS_STACK_OVERFLOW', 'the native stack was exhausted (runaway recursion below the JS layer)'],
  ],
  [
    0xc0000409,
    [
      'STATUS_STACK_BUFFER_OVERRUN',
      "Node's abort() — normally a V8 fatal error or a JS-heap OOM, which DOES write a report.*.json",
    ],
  ],
  [0xc0000374, ['STATUS_HEAP_CORRUPTION', 'the native heap was detected as corrupt']],
  [0x80000003, ['STATUS_BREAKPOINT', 'a debug break with no debugger attached']],
  [0xc000013a, ['STATUS_CONTROL_C_EXIT', 'Ctrl+C, or the console window closed']],
  [0xc0000017, ['STATUS_NO_MEMORY', 'the OS refused an allocation']],
  [
    0xc0000135,
    ['STATUS_DLL_NOT_FOUND', 'a required DLL is missing (a native module built against another runtime?)'],
  ],
  [0xc0000142, ['STATUS_DLL_INIT_FAILED', 'a DLL failed to initialize']],
  [
    0xc000041d,
    ['STATUS_FATAL_USER_CALLBACK_EXCEPTION', 'an exception escaped a native callback'],
  ],
]);

// Windows reports a fault as a large unsigned value in the 0x80000000+ range.
// A plain `process.exit(3)` is never in that range, so this can't misread one.
function ntstatusFor(code) {
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0x80000000) return null;
  return NTSTATUS.get(code >>> 0) ?? null;
}

/**
 * True when `code` is an OS-level fault rather than an exit the process chose.
 * Callers use this to decide whether "it crashed" or "it exited".
 */
export function isHardFault(code) {
  return typeof code === 'number' && Number.isInteger(code) &&
    code >= 0x80000000 && code < 0xffffffff;
}

/**
 * One human-readable phrase for a child's cause of death, suitable for both the
 * console line and the dev-runner log record. A signal takes precedence (POSIX);
 * otherwise a Windows fault code is decoded, and anything else renders as-is.
 */
export function describeExitCode(code, signal = null) {
  if (signal) return `signal ${signal}`;
  if (typeof code !== 'number') return 'code unknown';
  if (code === -1 || code === 0xffffffff) {
    return `code ${code} = 0xFFFFFFFF (exit -1; this code alone does not identify the cause)`;
  }
  if (!isHardFault(code)) return `code ${code}`;
  const hex = `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  const status = ntstatusFor(code);
  // Even an unrecognised status is worth rendering in hex — that form is what
  // an NTSTATUS lookup takes, and the decimal one is what makes it unsearchable.
  if (!status) return `code ${code} = ${hex} (unrecognised Windows fault status)`;
  const [name, explanation] = status;
  return `code ${code} = ${hex} ${name} — ${explanation}`;
}
