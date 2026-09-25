import type { TerminalServerStatus } from '../api/terminals';

// Pure copy for the navbar's "terminal server update pending" chip. Only a
// `stale` executor produces a chip; every other state (current, absent — the
// next terminal spawns a fresh one — or unreachable) shows nothing.

export type TerminalServerChip = { label: string; title: string };

export function deriveTerminalServerChip(
  status: TerminalServerStatus | null,
): TerminalServerChip | null {
  if (status?.state !== 'stale') return null;
  const n = status.sessions;
  const terminals = n === null ? 'all terminals are' : n === 1 ? 'its 1 terminal is' : `all ${n} terminals are`;
  return {
    label: 'Terminal server update pending',
    title:
      'The terminal server (the process that hosts agent terminals) is running an older build ' +
      'than the backend. Lattice keeps it alive so no running terminal is killed; the update ' +
      `applies once ${terminals} closed (on the next terminal launch), or on a full restart of ` +
      '`npm run dev`.',
  };
}
