// Rebuild a project's terminal tabs after a backend restart, a browser
// restart, a `Ctrl+C` of the dev server, or a reboot. Triggered on project
// open (`POST /api/terminal-tabs/restore`) and by the sidebar's "Restore tabs"
// button. Single-flighted per project — including while its relaunches are
// still in flight, so an overlapping pass can never double-spawn a tab.
//
// Per candidate record — the non-ended ones, plus (only for an explicit
// "Restore tabs" click, `retryFailed`) the ended-but-retryable ones: a tab
// whose relaunch failed or whose cwd was missing gets another go once the user
// asks, never on every project open (that re-reported the same drop forever).
// In tab order:
//   1. its pty id is live                    → ADOPT (nothing to do)
//   2. an unclaimed live AGENT pty in the same cwd running the same harness
//                                            → ADOPT it (record lost its id)
//   3. pty gone, executor instance unchanged → it EXITED → end the record
//   4. otherwise                             → RELAUNCH, if the owner allows:
//        user  — cwd must still exist
//        task  — task still in_progress + worktree present
//        merge — never: a dead resolver is ended silently. The merge-run
//                recovery (`resumeInterruptedMergeRuns` → respawn) and a
//                re-clicked manual merge spawn their own resolver, and a
//                relaunch racing either would put two Claudes on one conflict.
//                A resolver pty that is still alive is adopted like any other.
//        startup — never: the record is ended so useStartupTerminals reseeds
//                a fresh one from the settings (a dead startup record would
//                otherwise linger as a dead tab beside the fresh one)
//        one-shot runs — never (their own recovery owns them) → ended
//
// Relaunches go through the spawn queue at batch priority so 40 tabs come
// back gradually under `maxConcurrentAgents`; the summary returns at once and
// each outcome lands as a `restored` / `restore-failed` event on
// `/ws/terminal-tabs`. The relaunch itself lives in `restoreRelaunch.ts`.

import fs from 'node:fs/promises';
import { agentHarnessForCommand } from '../harnesses.js';
import { enqueueSpawn } from '../spawnQueue.js';
import { getTask } from '../tasks.js';
import { getUserSettings } from '../userSettings.js';
import { proxyCreateSession } from '../terminalServerClient/createSession.js';
import { proxyKillSession, proxyListSessionsOrNull } from '../terminalServerClient/sessions.js';
import { normalizeCwd } from './harnessPaths.js';
import { detectInterruption } from './interruption.js';
import { terminalRegistry } from './store.js';
import type { RestoreDropped, RestoreSummary, TerminalRecord } from './types.js';
import { isNewerThanLiveView, readLiveSessions, reconcileExitedTerminals, type LiveSessionsView } from './watch.js';
import { discoverCodexSessionFor } from './codexDiscovery.js';
import { agentSessionFromCommand } from './sessionIdentity.js';
import { enqueueRelaunch, scheduleDiscoveryIfUnknown } from './restoreRelaunch.js';

type LiveSession = { id: string; cwd: string; initialCommand?: string };

export type RestoreDeps = {
  readLiveSessions: () => Promise<LiveSessionsView | null>;
  listLiveSessions: () => Promise<LiveSession[]>;
  createSession: typeof proxyCreateSession;
  // Reclaims a pty whose tab was closed while the relaunch was in flight.
  killSession: (id: string) => Promise<boolean>;
  enqueue: typeof enqueueSpawn;
  getTask: typeof getTask;
  getUserSettings: typeof getUserSettings;
  detectInterruption: typeof detectInterruption;
  // One Codex rollout-discovery attempt for a record (true once its id is known).
  discoverCodexSession: (recordId: string, projectPath: string) => Promise<boolean>;
  dirExists: (p: string) => Promise<boolean>;
  now: () => number;
};

async function dirExists(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

const productionDeps: RestoreDeps = {
  readLiveSessions,
  listLiveSessions: async () => {
    const raw = await proxyListSessionsOrNull();
    const out: LiveSession[] = [];
    for (const s of raw ?? []) {
      const r = s as { id?: unknown; cwd?: unknown; initialCommand?: unknown };
      if (typeof r.id === 'string' && typeof r.cwd === 'string') {
        out.push({ id: r.id, cwd: r.cwd, initialCommand: typeof r.initialCommand === 'string' ? r.initialCommand : undefined });
      }
    }
    return out;
  },
  createSession: proxyCreateSession,
  killSession: proxyKillSession,
  enqueue: enqueueSpawn,
  getTask,
  getUserSettings,
  detectInterruption,
  discoverCodexSession: discoverCodexSessionFor,
  dirExists,
  now: Date.now,
};

// Ended records that restore may try again once the user has fixed the cause.
export function isRetryableEnd(record: TerminalRecord): boolean {
  return record.ended?.reason === 'cwd-missing' || record.ended?.reason === 'restore-failed';
}

type OwnerCheck = { ok: true } | { ok: false; reason: string; end: boolean; report: boolean };

async function checkOwner(record: TerminalRecord, deps: RestoreDeps): Promise<OwnerCheck> {
  switch (record.owner) {
    case 'user':
      return { ok: true };
    case 'task': {
      if (!record.taskId) return { ok: false, reason: 'task id missing', end: true, report: true };
      const task = await deps.getTask(record.taskId);
      if (!task) return { ok: false, reason: 'task no longer exists', end: true, report: true };
      if (task.status !== 'in_progress') {
        return { ok: false, reason: `task is ${task.status}`, end: true, report: true };
      }
      if (!task.worktreePath || normalizeCwd(task.worktreePath) !== normalizeCwd(record.cwd)) {
        return { ok: false, reason: 'task worktree moved', end: true, report: true };
      }
      return { ok: true };
    }
    case 'merge':
      // Adopt-only: a live resolver was taken in step 1/2; a dead one belongs
      // to the merge-run recovery / a re-clicked merge, which spawn their own.
      return { ok: false, reason: 'conflict resolvers are respawned by the merge flow', end: true, report: false };
    case 'startup':
      // Expected turnover, not a dropped tab: the settings re-seed it.
      return { ok: false, reason: 'startup terminals are re-seeded from their settings', end: true, report: false };
    default:
      return { ok: false, reason: `${record.owner} runs are owned by their own recovery`, end: true, report: true };
  }
}

// Per project: the summary of the pass in progress plus a promise that settles
// once every relaunch it queued has finished. A second call while that is
// pending answers `already-running` instead of racing the thunks.
const inFlight = new Map<string, Promise<void>>();

// The longest a pass's relaunches may hold the single-flight: a stuck thunk
// must not block every later restore of the project forever.
const RELAUNCH_LOCK_MAX_HOLD_MS = 10 * 60_000;

export type RestoreOptions = {
  // Also retry records that ended as `cwd-missing` / `restore-failed`. Only the
  // explicit "Restore tabs" action sets this; the on-open pass never does.
  retryFailed?: boolean;
};

export async function restoreProjectTerminals(
  projectPath: string,
  deps: RestoreDeps = productionDeps,
  options: RestoreOptions = {},
): Promise<RestoreSummary> {
  const key = normalizeCwd(projectPath);
  if (inFlight.has(key)) {
    return { status: 'already-running', adopted: 0, queued: 0, dropped: [], relaunchedIds: [] };
  }
  let release!: () => void;
  const settled = new Promise<void>((resolve) => { release = resolve; });
  inFlight.set(key, settled);
  // Only THIS pass may release its own lock: a later pass's lock must survive
  // an earlier pass's guard timer firing.
  const done = () => {
    if (inFlight.get(key) === settled) inFlight.delete(key);
    release();
  };
  try {
    const { summary, relaunches } = await performRestore(projectPath, deps, options);
    // Hold the single-flight until the relaunches are done — but never let a
    // stuck thunk hold it forever.
    const guard = setTimeout(done, RELAUNCH_LOCK_MAX_HOLD_MS);
    guard.unref();
    void Promise.allSettled(relaunches).then(() => {
      clearTimeout(guard);
      done();
    });
    return summary;
  } catch (err) {
    done();
    throw err;
  }
}

async function performRestore(
  projectPath: string,
  deps: RestoreDeps,
  options: RestoreOptions,
): Promise<{ summary: RestoreSummary; relaunches: Promise<void>[] }> {
  const live = await deps.readLiveSessions();
  if (!live) {
    const summary: RestoreSummary = {
      status: 'terminal-server-unreachable', adopted: 0, queued: 0, dropped: [], relaunchedIds: [],
    };
    terminalRegistry.emitRestoreSummary(projectPath, summary);
    return { summary, relaunches: [] };
  }
  // Load the project's records, then apply the exit rule across everything
  // loaded so a pty that died while the executor lived is never relaunched.
  await terminalRegistry.list(projectPath);
  await reconcileExitedTerminals(live);
  const records = (await terminalRegistry.list(projectPath, { includeEnded: true }))
    .filter((r) => !r.ended || (options.retryFailed === true && isRetryableEnd(r)));
  const liveSessions = await deps.listLiveSessions();
  // A record (re)pointed at a pty after the live view was taken — a tab
  // spawned while this pass was reading — is live as far as this pass can
  // tell: relaunching it would put a second agent beside the first.
  const isLive = (r: TerminalRecord): boolean =>
    !!r.serverId && (live.serverIds.has(r.serverId) || isNewerThanLiveView(r, live));
  const claimed = new Set<string>();
  for (const r of records) if (isLive(r)) claimed.add(r.serverId!);

  let adopted = 0;
  let queued = 0;
  const dropped: RestoreDropped[] = [];
  const relaunchedIds: string[] = [];
  const relaunches: Promise<void>[] = [];

  for (const record of records) {
    // 1. pty still live → adopt.
    if (isLive(record)) {
      adopted += 1;
      terminalRegistry.emitRestored(record, 'adopted');
      scheduleDiscoveryIfUnknown(record);
      continue;
    }
    // 2. an unclaimed live AGENT pty in the same cwd running the same harness
    //    → adopt.
    if (await tryAdoptOrphan(record, liveSessions, claimed, live)) {
      adopted += 1;
      continue;
    }
    // 3. (handled by reconcileExitedTerminals: exited records are gone by now)
    // 4. relaunch, if the owner allows.
    const owner = await checkOwner(record, deps);
    if (!owner.ok) {
      if (owner.end) {
        await terminalRegistry.end(record.id, { reason: 'owner-finished', detail: owner.reason }, record.projectPath);
        if (owner.report) dropped.push({ id: record.id, label: record.label, reason: owner.reason });
      }
      continue;
    }
    if (!(await deps.dirExists(record.cwd))) {
      await terminalRegistry.end(record.id, { reason: 'cwd-missing', detail: record.cwd }, record.projectPath);
      dropped.push({ id: record.id, label: record.label, reason: `working directory missing: ${record.cwd}` });
      continue;
    }
    queued += 1;
    relaunchedIds.push(record.id);
    // The recorded pty is dead: drop its id now so every client renders the
    // tab as "restoring" (no pane attaches to a dead id) until the relaunch
    // lands a new one. A retried failure sheds its `ended` marker the same way.
    await terminalRegistry.update(record.id, {
      serverId: undefined, serverInstanceId: undefined, ended: undefined, relaunching: true,
    }, record.projectPath);
    relaunches.push(enqueueRelaunch(record, deps));
  }

  const summary: RestoreSummary = { status: 'ok', adopted, queued, dropped, relaunchedIds };
  terminalRegistry.emitRestoreSummary(projectPath, summary);
  return { summary, relaunches };
}

// Step 2: adopt an unclaimed live AGENT pty in the record's cwd running the
// record's harness (the record lost its pty id). Plain shells and startup
// commands never adopt: with no harness to match on, a dead shell record would
// claim whatever non-agent pty happened to open in that folder (a freshly
// re-seeded `npm run dev`, say). True once adopted (the pty is then claimed).
async function tryAdoptOrphan(
  record: TerminalRecord,
  liveSessions: LiveSession[],
  claimed: Set<string>,
  live: LiveSessionsView,
): Promise<boolean> {
  const harness = agentHarnessForCommand(record.launch.initialCommand);
  if (!harness) return false;
  const orphan = liveSessions.find((s) =>
    !claimed.has(s.id) && normalizeCwd(s.cwd) === normalizeCwd(record.cwd)
    && agentHarnessForCommand(s.initialCommand) === harness);
  if (!orphan) return false;
  claimed.add(orphan.id);
  // The record's own id belonged to its dead pty; the adopted one runs
  // whatever conversation ITS command names. Keeping the old id would
  // resume the wrong conversation on the next restart.
  const orphanSession = agentSessionFromCommand(orphan.initialCommand);
  const updated = await terminalRegistry.update(record.id, {
    serverId: orphan.id,
    serverInstanceId: live.instanceId ?? undefined,
    ...(orphanSession ? { agentSession: orphanSession } : {}),
  }, record.projectPath);
  terminalRegistry.emitRestored(updated ?? record, 'adopted');
  scheduleDiscoveryIfUnknown(updated ?? record);
  return true;
}
