export const ANSI_DIM_CYAN = '\x1b[2;36m';
export const ANSI_RESET = '\x1b[0m';

export function buildLatticeBanner(): string {
  // Dim cyan so the banner reads as ambient terminal chrome rather than
  // user-relevant output. \r\n because the pty is in raw mode; a bare \n
  // would not return the cursor to column 0.
  return (
    '\r\n' +
    `${ANSI_DIM_CYAN}[Lattice] AI agents: when the user mentions Lattice / tasks / taskboard / merging / worktrees, read $LATTICE_DOCS for the API reference.${ANSI_RESET}` +
    '\r\n'
  );
}
