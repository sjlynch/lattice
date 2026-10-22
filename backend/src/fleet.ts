// Fleet: one view of — and one set of controls over — every project on this
// machine. A machine-wide activity feed (fleet/events.ts), a cross-project
// snapshot (fleet/snapshot.ts), terminal screen / input / wait over the
// executor's own attach socket (fleet/terminal.ts) and "prompt a project"
// agent launches (fleet/launch.ts). Served by routes/fleet.ts to the Fleet
// view and to agents (MCP fleet tools); agents need the `fleetAgentControl`
// global setting for anything beyond the read-only snapshot.

import { agentHarnessForCommand } from './harnesses.js';
import { listAgentSessions } from './agentSessions.js';
import { getGlobalSettings } from './globalSettings.js';
import { getActiveRunForProject } from './mergeRuns.js';
import { listKnownProjects, listTasks } from './tasks.js';
import { terminalRegistry } from './terminalRegistry.js';
import { proxyCreateSession } from './terminalProxy.js';
import { proxyListSessionsShared } from './terminalServerClient.js';
import { subscribeTerminalActivity } from './terminalActivity.js';
import { isCodexYoloEnabled } from './userSettings.js';
import { getActiveRunsForProject } from './workflowRuns.js';
import { createFleetEventLog, wireFleetEvents } from './fleet/events.js';
import { launchFleetAgent, type FleetLaunchInput } from './fleet/launch.js';
import { buildFleetProjects } from './fleet/snapshot.js';
import type { FleetLaunchResult, FleetMachine, FleetProject, FleetSnapshot } from './fleet/types.js';
import { readRemoteFleets } from './peers.js';

export { FleetLaunchError, parseFleetLaunch } from './fleet/launch.js';
export { readTerminalScreen, sendTerminalInput, waitTerminalQuiet, TerminalControlError } from './fleet/terminal.js';

const log = createFleetEventLog();
let busyIds: ReadonlySet<string> = new Set();
let started = false;

// Boot: start listening to every per-project feed. Idempotent.
export function startFleet(): void {
  if (started) return;
  started = true;
  wireFleetEvents(log);
  subscribeTerminalActivity((ids) => { busyIds = new Set(ids); });
}

export async function isFleetAgentControlOn(): Promise<boolean> {
  return (await getGlobalSettings().catch(() => null))?.fleetAgentControl === true;
}

export async function readFleetSnapshot(since = 0, opts: { machines?: boolean } = {}): Promise<FleetSnapshot> {
  const projects = await buildFleetProjects({
    knownProjects: listKnownProjects,
    tasksOf: listTasks,
    workflowRuns: getActiveRunsForProject,
    mergeRun: getActiveRunForProject,
    agents: listAgentSessions,
    // A shorter TTL than the shared default: a terminal opened a moment ago
    // should be on the next poll.
    ptys: () => proxyListSessionsShared({ ttlMs: 200 }),
    records: () => terminalRegistry.loadedRecords().map((x) => x.record),
    busy: () => busyIds,
    harnessFor: agentHarnessForCommand,
    now: Date.now,
  });
  const machines: FleetMachine[] | undefined = opts.machines
    ? (await readRemoteFleets()).map((m) => {
      const snap = m.snapshot as Partial<FleetSnapshot> | undefined;
      return m.ok && snap
        ? { name: m.name, ok: true, projects: (snap.projects ?? []) as FleetProject[], events: (snap.events ?? []).slice(-50), agentControl: snap.agentControl === true }
        : { name: m.name, ok: false, ...(m.error ? { error: m.error } : {}) };
    })
    : undefined;
  return {
    generatedAt: Date.now(),
    projects,
    events: log.since(since),
    seq: log.seq(),
    agentControl: await isFleetAgentControlOn(),
    ...(machines?.length ? { machines } : {}),
  };
}

export function launchFleetAgentNow(input: FleetLaunchInput): Promise<FleetLaunchResult> {
  return launchFleetAgent(input, { createSession: proxyCreateSession, codexYolo: isCodexYoloEnabled, now: Date.now });
}
