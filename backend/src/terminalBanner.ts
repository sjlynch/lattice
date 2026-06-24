export const ANSI_DIM_CYAN = '\x1b[2;36m';
export const ANSI_RESET = '\x1b[0m';

// The banner names the doc by its LITERAL absolute path — never `$LATTICE_DOCS`.
// The pty's default shell on Windows is cmd.exe (COMSPEC), where `$LATTICE_DOCS`
// is a non-expanding literal, so a `$VAR`-shaped hint silently no-ops and the
// agent never finds the API reference. An absolute path works in cmd.exe,
// PowerShell, and POSIX shells alike, for any harness. `docPath` is always in
// hand here (the banner is only emitted for Lattice-managed projects, which by
// definition have a generated doc).
export function buildLatticeBanner(docPath: string): string {
  // Dim cyan so the banner reads as ambient terminal chrome rather than
  // user-relevant output. \r\n because the pty is in raw mode; a bare \n
  // would not return the cursor to column 0.
  return (
    '\r\n' +
    `${ANSI_DIM_CYAN}[Lattice] AI agents: when the user mentions Lattice / tasks / taskboard / merging / worktrees, read the API reference at ${docPath}${ANSI_RESET}` +
    '\r\n'
  );
}
