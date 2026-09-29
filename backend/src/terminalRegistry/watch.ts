// Keeps the registry honest against the live terminal-server while the
// backend is up:
//
//   - exit tracking: a record whose pty id is missing from `/sessions` while
//     the executor INSTANCE is unchanged means the pty exited (agent quit,
//     shell closed, Lattice killed it). Such a tab must not be relaunched by
//     restore, so the record is ended. A different instance id (the executor
//     was replaced — reboot, Ctrl+C, idle upgrade) says nothing about any one
//     pty; those records are left for restore to relaunch.
//   - busy tracking: the terminal-activity signal's transitions are stamped
//     onto records (`lastBusy`) so the interruption detector has a ≤2 s-stale
//     "was it working" fact after everything dies.
//
// Both are best-effort and never touch a pty. An unreachable executor is
// "can't tell", not "everything exited".

import { probeTerminalServer } from '../terminalServerLifecycle.js';
import { proxyListSessionsOrNull } from '../terminalServerClient/sessions.js';
import { subscribeTerminalActivity } from '../terminalActivity.js';
import { terminalRegistry } from './store.js';
import { pollCodexTaskActivity } from './codexTaskActivity.js';

const WATCH_INTERVAL_MS = 3_000;

export type LiveSessionsView = {
  instanceId: string | null;
  serverIds: Set<string>;
  // Wall-clock (this process) just BEFORE `/sessions` was requested. A record
  // written at/after it may carry a pty the list could not have contained —
  // one created while the GET was in flight or while the caller was still
  // awaiting other work — so its absence proves nothing. Absent ⇒ no guard.
  listedAt?: number;
};

// True when `record` was (re)pointed at its pty after the live view was
// taken: `recordSpawnedTerminal` writes serverId (bumping `updatedAt`) only
// after the executor created the pty, which is after the GET was sent. Such a
// record is judged on the next pass, never ended (or relaunched) on this one.
export function isNewerThanLiveView(
  record: { updatedAt: number },
  live: LiveSessionsView,
): boolean {
  return live.listedAt !== undefined && record.updatedAt >= live.listedAt;
}

// The session list is read LIVE, never from the activity poller's shared
// ≤750 ms snapshot: this read decides "the pty is gone, end the record", and a
// snapshot taken before a pty was spawned reports that pty missing. With the
// watch on the snapshot, a tab created inside that window lost its registry
// record within a tick (seen by the restore e2e: a fresh "+" shell whose
// record vanished while its pty lived on). One extra GET per 3 s is cheap;
// a wrong exit verdict is a tab that can never be restored.
export async function readLiveSessions(
  deps: { probe: typeof probeTerminalServer; list: () => Promise<unknown[] | null> } =
    { probe: probeTerminalServer, list: proxyListSessionsOrNull },
): Promise<LiveSessionsView | null> {
  const probe = await deps.probe();
  if (probe.kind !== 'ready') return null;
  const listedAt = Date.now();
  const sessions = await deps.list();
  if (sessions === null) return null;
  const serverIds = new Set<string>();
  for (const s of sessions) {
    const id = (s as { id?: unknown })?.id;
    if (typeof id === 'string' && id) serverIds.add(id);
  }
  return { instanceId: probe.info.instanceId ?? null, serverIds, listedAt };
}

// One reconciliation pass over the loaded records. Exported for tests and for
// the restore flow, which runs the same rule before deciding what to relaunch.
export async function reconcileExitedTerminals(live: LiveSessionsView): Promise<number> {
  if (!live.instanceId) return 0;
  let ended = 0;
  for (const { projectKey, record } of terminalRegistry.loadedRecords()) {
    if (record.ended || !record.serverId) continue;
    if (live.serverIds.has(record.serverId)) {
      if (record.serverInstanceId !== live.instanceId) {
        await terminalRegistry.update(record.id, { serverInstanceId: live.instanceId }, projectKey);
      }
      continue;
    }
    if (!record.serverInstanceId || record.serverInstanceId !== live.instanceId) continue;
    // `loadedRecords()` was snapshotted before this loop's awaits: re-read the
    // record so one that was relaunched / re-pointed meanwhile is judged on
    // its CURRENT pty. And a pty spawned after the list was requested is
    // missing from it by construction — ending it would delete a live tab.
    const current = await terminalRegistry.get(record.id, projectKey);
    if (!current || current.ended || current.serverId !== record.serverId) continue;
    if (isNewerThanLiveView(current, live)) continue;
    if (await terminalRegistry.end(record.id, { reason: 'exit' }, projectKey)) ended += 1;
  }
  return ended;
}

let started = false;

export function startTerminalRegistryWatch(): void {
  if (started) return;
  started = true;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const live = await readLiveSessions();
        if (live) {
          await reconcileExitedTerminals(live);
          await pollCodexTaskActivity(live);
        }
      } catch (err) {
        console.warn('[terminal-registry] watch tick failed:', err);
      } finally {
        inFlight = false;
      }
    })();
  }, WATCH_INTERVAL_MS);
  timer.unref();
  // Keeps the shared activity poller alive for the life of the process; the
  // poll is one loopback GET per second and serves the sidebar spinner too.
  subscribeTerminalActivity((busy) => {
    void terminalRegistry.noteBusy(new Set(busy)).catch(() => {});
  });
}
