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
import os from 'node:os';
import type { FleetHost, FleetLaunchResult, FleetMachine, FleetProject, FleetSnapshot } from './fleet/types.js';
import { detectHarnesses } from './harnessDetect.js';
import { getPiModels } from './piModels.js';
import { readPlanUsage } from './planUsage.js';
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

// This PC's profile, rebuilt at most once a minute (the Fleet panel polls
// every 3 s; harness / Pi / plan reads are not free).
let hostCache: { at: number; value: FleetHost } | null = null;
async function readHost(): Promise<FleetHost> {
  if (hostCache && Date.now() - hostCache.at < 60_000) return hostCache.value;
  const [harnesses, pi, usage] = await Promise.all([
    detectHarnesses().catch(() => ({})),
    getGlobalSettings().then((g) => getPiModels(g.piModelMenu)).catch(() => null),
    readPlanUsage().catch(() => null),
  ]);
  const value: FleetHost = {
    name: os.hostname(),
    harnesses,
    piModels: (pi?.menu ?? []).map((m) => m.label).slice(0, 20),
    plans: (usage?.providers ?? []).map((p) => {
      const w = [...p.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
      return { provider: p.provider, ...(p.plan ? { plan: p.plan } : {}), ...(w ? { usedPercent: w.usedPercent, window: w.label } : {}) };
    }),
  };
  hostCache = { at: Date.now(), value };
  return value;
}

export async function readFleetSnapshot(since = 0, opts: { machines?: boolean; host?: boolean } = {}): Promise<FleetSnapshot> {
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
        ? { name: m.name, ok: true, projects: (snap.projects ?? []) as FleetProject[], events: (snap.events ?? []).slice(-50), agentControl: snap.agentControl === true, ...(snap.host ? { host: snap.host } : {}) }
        : { name: m.name, ok: false, ...(m.error ? { error: m.error } : {}) };
    })
    : undefined;
  return {
    generatedAt: Date.now(),
    projects,
    events: log.since(since),
    seq: log.seq(),
    agentControl: await isFleetAgentControlOn(),
    ...(opts.host === false ? {} : { host: await readHost() }),
    ...(machines?.length ? { machines } : {}),
  };
}

export function launchFleetAgentNow(input: FleetLaunchInput): Promise<FleetLaunchResult> {
  return launchFleetAgent(input, { createSession: proxyCreateSession, codexYolo: isCodexYoloEnabled, now: Date.now });
}
