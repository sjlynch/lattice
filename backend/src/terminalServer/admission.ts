/** One event-loop gate shared by HTTP creates, WS creates and idle upgrades. */
export function createTerminalAdmission() {
  let closing = false;
  let pendingCreates = 0;
  return {
    begin(): (() => void) | null {
      if (closing) return null;
      pendingCreates++;
      let released = false;
      return () => {
        if (!released) { released = true; pendingCreates--; }
      };
    },
    closeIfIdle(liveSessions: number): boolean {
      if (liveSessions || pendingCreates) return false;
      closing = true;
      return true;
    },
    close(): void { closing = true; },
  };
}

export type TerminalAdmission = ReturnType<typeof createTerminalAdmission>;
