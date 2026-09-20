// Pure decision behind `useStartupTerminals`' seeding pass: which persisted
// specs are stale (their pty is gone) and which configured startup commands
// need a fresh spawn. React-free so the reseed-vs-registry race is testable.

import type { StartupTerminal, TerminalRecord } from '../../../api';
import type { TerminalSpec } from '../../../terminal/terminalTypes';

export type StartupSeedPlan = {
  // Unregistered (legacy sessionStorage) specs whose serverId is dead.
  staleIds: string[];
  // Configured startups with no live spec anywhere — spawn these.
  spawn: StartupTerminal[];
};

export function startupInFlightKey(activeFolder: string, startupId: string): string {
  return `${activeFolder}::${startupId}`;
}

function ptyIsLive(serverId: string | undefined, liveIds: ReadonlySet<string> | null): boolean {
  // No serverId = a serverless spec that will spawn on attach; an unreadable
  // live set = "can't tell", so treat every pty as alive rather than respawn.
  if (!serverId || !liveIds) return true;
  return liveIds.has(serverId);
}

export function planStartupSeeding(args: {
  activeFolder: string;
  configs: StartupTerminal[];
  // The sidebar's current specs for this project (may lag the registry).
  existing: TerminalSpec[];
  // `GET /api/terminals` ids, or null when unreadable.
  liveIds: ReadonlySet<string> | null;
  // The project's registry records, or null when the fetch failed. Consulted
  // in ADDITION to `existing`: on a fresh browser context (empty
  // sessionStorage) the local list is empty until the registry snapshot lands,
  // and deciding from it alone spawned a SECOND copy of a startup command
  // whose pty was alive and about to be adopted — two `npm run dev`s fighting
  // over one port.
  records: TerminalRecord[] | null;
  inFlight: ReadonlySet<string>;
}): StartupSeedPlan {
  const { activeFolder, configs, existing, liveIds, records, inFlight } = args;
  const staleIds = liveIds
    ? existing
        .filter((t) => !t.registered && t.serverId && !liveIds.has(t.serverId))
        .map((t) => t.id)
    : [];

  const spawn: StartupTerminal[] = [];
  for (const cfg of configs) {
    if (!cfg.command.trim()) continue;
    if (inFlight.has(startupInFlightKey(activeFolder, cfg.id))) continue;
    const liveSpec = existing.some(
      (t) =>
        t.kind === 'startup' &&
        t.startupId === cfg.id &&
        t.projectPath === activeFolder &&
        ptyIsLive(t.serverId, liveIds),
    );
    if (liveSpec) continue;
    const liveRecord = !!records && records.some(
      (r) =>
        r.owner === 'startup' &&
        r.startupId === cfg.id &&
        !r.ended &&
        // A record with no pty is one the registry is not going to relaunch
        // (startup records are never relaunched), so it does not count.
        !!r.serverId &&
        ptyIsLive(r.serverId, liveIds),
    );
    if (liveRecord) continue;
    spawn.push(cfg);
  }
  return { staleIds, spawn };
}
