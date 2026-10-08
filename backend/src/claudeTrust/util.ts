// Tiny shared primitive for the `~/.claude.json` I/O + locking modules.
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
