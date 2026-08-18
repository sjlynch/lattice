export const ANSI_DIM_CYAN = '\x1b[2;36m';
export const ANSI_RESET = '\x1b[0m';

// HUMAN-FACING chrome, not an agent channel. This line is appended to the
// session's SCROLLBACK — the buffer the browser replays into xterm — so the pty
// child never receives it and no harness can read it. Agents are pointed at the
// same doc by the system-prompt preamble the backend injects at spawn
// (harnessSystemPrompts/latticePreamble.ts); this banner just tells the USER the
// reference exists.
//
// It names the doc by its LITERAL absolute path so a reader can paste it into
// any shell (the pty default on Windows is cmd.exe, where a `$VAR` reference
// would not expand). `docPath` is always in hand here — the banner is only
// emitted for Lattice-managed projects, which by definition have a generated
// doc.
export function buildLatticeBanner(docPath: string): string {
  // Dim cyan so the banner reads as ambient terminal chrome rather than
  // user-relevant output. \r\n because the pty is in raw mode; a bare \n
  // would not return the cursor to column 0.
  return (
    '\r\n' +
    `${ANSI_DIM_CYAN}[Lattice] Task board / merging / worktree API reference for this project: ${docPath}${ANSI_RESET}` +
    '\r\n'
  );
}
