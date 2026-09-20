// Rebuild a project's terminal tabs after a backend restart, a browser
// restart, a `Ctrl+C` of the dev server, or a reboot. Triggered on project
// open (`POST /api/terminal-tabs/restore`) and by the sidebar's "Restore tabs"
// button. Single-flighted per project; safe to re-run.
//
// Per non-ended record, in tab order:
//   1. its pty id is live                    → ADOPT (nothing to do)
//   2. a live pty with the same cwd+harness  → ADOPT it (record lost its id)
//   3. pty gone, executor instance unchanged → it EXITED → end the record
//   4. otherwise                             → RELAUNCH, if the owner allows:
//        user  — cwd must still exist
//        task  — task still in_progress + worktree present
//        merge — task still conflict-flagged + worktree present
//        startup — never (useStartupTerminals owns re-seeding)
//        one-shot runs — never (their own recovery owns them) → ended
//
// Relaunches go through the spawn queue at batch priority so 40 tabs come
// back gradually under `maxConcurrentAgents`; the summary returns at once and
// each outcome lands as a `restored` / `restore-failed` event on
// `/ws/terminal-tabs`.

import fs from 'node:fs/promises';
import { agentHarnessForCommand } from '../harnesses.js';
import { enqueueSpawn, SpawnCapacityError } from '../spawnQueue.js';
import { getTask } from '../tasks.js';
import { getUserSettings, type UserSettings } from '../userSettings.js';
import { proxyCreateSession } from '../terminalServerClient/createSession.js';
import { proxyListSessionsOrNull } from '../terminalServerClient/sessions.js';
import { normalizeCwd } from './harnessPaths.js';
import { detectInterruption } from './interruption.js';
import { buildRestoreCommand, RESTORE_NUDGE } from './restoreCommand.js';
import { terminalRegistry } from './store.js';
import type { RestoreDropped, RestoreSummary, TerminalRecord } from './types.js';
import { readLiveSessions, reconcileExitedTerminals, type LiveSessionsView } from './watch.js';
import { scheduleCodexDiscovery } from './codexDiscovery.js';

export type RestoreDeps = {
  readLiveSessions: () => Promise<LiveSessionsView | null>;
  listLiveSessions: () => Promise<Array<{ id: string; cwd: string; initialCommand?: string }>>;
  createSession: typeof proxyCreateSession;
  enqueue: typeof enqueueSpawn;
  getTask: typeof getTask;
  getUserSettings: typeof getUserSettings;
  detectInterruption: typeof detectInterruption;
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
    const out: Array<{ id: string; cwd: string; initialCommand?: string }> = [];
    for (const s of raw ?? []) {
      const r = s as { id?: unknown; cwd?: unknown; initialCommand?: unknown };
      if (typeof r.id === 'string' && typeof r.cwd === 'string') {
        out.push({ id: r.id, cwd: r.cwd, initialCommand: typeof r.initialCommand === 'string' ? r.initialCommand : undefined });
      }
    }
    return out;
  },
  createSession: proxyCreateSession,
  enqueue: enqueueSpawn,
  getTask,
  getUserSettings,
  detectInterruption,
  dirExists,
  now: Date.now,
};

type OwnerCheck = { ok: true } | { ok: false; reason: string; end: boolean };

async function checkOwner(record: TerminalRecord, deps: RestoreDeps): Promise<OwnerCheck> {
  switch (record.owner) {
    case 'user':
      return { ok: true };
    case 'task':
    case 'merge': {
      if (!record.taskId) return { ok: false, reason: 'task id missing', end: true };
      const task = await deps.getTask(record.taskId);
      if (!task) return { ok: false, reason: 'task no longer exists', end: true };
      if (task.status !== 'in_progress') {
        return { ok: false, reason: `task is ${task.status}`, end: true };
      }
      if (record.owner === 'merge' && !task.conflict) {
        return { ok: false, reason: 'task is no longer in conflict', end: true };
      }
      if (!task.worktreePath || normalizeCwd(task.worktreePath) !== normalizeCwd(record.cwd)) {
        return { ok: false, reason: 'task worktree moved', end: true };
      }
      return { ok: true };
    }
    case 'startup':
      return { ok: false, reason: 'startup terminals are re-seeded by their settings', end: false };
    default:
      return { ok: false, reason: `${record.owner} runs are owned by their own recovery`, end: true };
  }
}

// Whether to send the continue-nudge for this relaunch.
async function resolveNudge(record: TerminalRecord, deps: RestoreDeps): Promise<string | undefined> {
  const settings: UserSettings = await deps.getUserSettings(record.projectPath).catch(() => ({}));
  if (record.owner === 'task' || record.owner === 'merge') {
    return settings.restoreNudgeAgents === false ? undefined : RESTORE_NUDGE;
  }
  if (record.owner === 'user' && settings.restoreNudgeUserTabs === true) {
    const verdict = await deps.detectInterruption(record);
    return verdict.interruption === 'interrupted' ? RESTORE_NUDGE : undefined;
  }
  return undefined;
}

const inFlight = new Map<string, Promise<RestoreSummary>>();

export function restoreProjectTerminals(
  projectPath: string,
  deps: RestoreDeps = productionDeps,
): Promise<RestoreSummary> {
  const key = normalizeCwd(projectPath);
  const existing = inFlight.get(key);
  if (existing) {
    return Promise.resolve({ status: 'already-running', adopted: 0, queued: 0, dropped: [], relaunchedIds: [] });
  }
  const run = performRestore(projectPath, deps).finally(() => { inFlight.delete(key); });
  inFlight.set(key, run);
  return run;
}

async function performRestore(projectPath: string, deps: RestoreDeps): Promise<RestoreSummary> {
  const live = await deps.readLiveSessions();
  if (!live) {
    const summary: RestoreSummary = {
      status: 'terminal-server-unreachable', adopted: 0, queued: 0, dropped: [], relaunchedIds: [],
    };
    terminalRegistry.emitRestoreSummary(projectPath, summary);
    return summary;
  }
  // Load the project's records, then apply the exit rule across everything
  // loaded so a pty that died while the executor lived is never relaunched.
  await terminalRegistry.list(projectPath);
  await reconcileExitedTerminals(live);
  const records = await terminalRegistry.list(projectPath);
  const liveSessions = await deps.listLiveSessions();
  const claimed = new Set<string>();
  for (const r of records) if (r.serverId && live.serverIds.has(r.serverId)) claimed.add(r.serverId);

  let adopted = 0;
  let queued = 0;
  const dropped: RestoreDropped[] = [];
  const relaunchedIds: string[] = [];

  for (const record of records) {
    // 1. pty still live → adopt.
    if (record.serverId && live.serverIds.has(record.serverId)) {
      adopted += 1;
      terminalRegistry.emitRestored(record, 'adopted');
      continue;
    }
    // 2. an unclaimed live pty in the same cwd running the same harness → adopt.
    const harness = agentHarnessForCommand(record.launch.initialCommand);
    const orphan = liveSessions.find((s) =>
      !claimed.has(s.id) && normalizeCwd(s.cwd) === normalizeCwd(record.cwd)
      && agentHarnessForCommand(s.initialCommand) === harness);
    if (orphan) {
      claimed.add(orphan.id);
      const updated = await terminalRegistry.update(record.id, {
        serverId: orphan.id, serverInstanceId: live.instanceId ?? undefined,
      }, record.projectPath);
      adopted += 1;
      terminalRegistry.emitRestored(updated ?? record, 'adopted');
      continue;
    }
    // 3. (handled by reconcileExitedTerminals: exited records are gone by now)
    // 4. relaunch, if the owner allows.
    const owner = await checkOwner(record, deps);
    if (!owner.ok) {
      if (owner.end) {
        await terminalRegistry.end(record.id, { reason: 'owner-finished', detail: owner.reason }, record.projectPath);
        dropped.push({ id: record.id, label: record.label, reason: owner.reason });
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
    // lands a new one.
    await terminalRegistry.update(record.id, { serverId: undefined, serverInstanceId: undefined }, record.projectPath);
    enqueueRelaunch(record, deps);
  }

  const summary: RestoreSummary = { status: 'ok', adopted, queued, dropped, relaunchedIds };
  terminalRegistry.emitRestoreSummary(projectPath, summary);
  return summary;
}

function enqueueRelaunch(record: TerminalRecord, deps: RestoreDeps): void {
  const { done } = deps.enqueue<void>({
    kind: 'terminal-restore',
    priority: 'batch',
    dedupeKey: `terminal-restore:${record.id}`,
    thunk: async () => {
      const current = await terminalRegistry.get(record.id, record.projectPath);
      if (!current || current.ended) return; // closed while queued
      const fail = async (reason: string) => {
        await terminalRegistry.end(current.id, { reason: 'restore-failed', detail: reason }, current.projectPath);
        terminalRegistry.emitRestoreFailed(current, reason);
      };
      let nudge: string | undefined;
      let transcriptExists = false;
      try {
        nudge = await resolveNudge(current, deps);
        if (current.agentSession?.harness === 'claude') {
          transcriptExists = (await deps.detectInterruption(current)).transcriptExists === true;
        }
      } catch { /* nudge / evidence are best-effort */ }
      const built = buildRestoreCommand({
        launch: current.launch,
        agentSession: current.agentSession,
        claudeTranscriptExists: transcriptExists,
        nudge,
      });
      const sess = await deps.createSession({
        cwd: current.cwd,
        initialCommand: built.command,
        projectPath: current.projectPath,
        isQaRun: current.launch.isQaRun,
        taskId: current.launch.taskId,
        registry: {
          owner: current.owner,
          label: current.label,
          kind: current.kind,
          taskId: current.taskId,
          startupId: current.startupId,
          piModel: current.launch.piModel,
          existingId: current.id,
          agentSession: built.agentSession,
        },
      });
      if ('error' in sess) {
        if (sess.code === 'CAP') throw new SpawnCapacityError(`terminal-restore ${current.id}: hard cap`);
        await fail(sess.error);
        return;
      }
      const restored = await terminalRegistry.get(current.id, current.projectPath);
      if (restored) {
        terminalRegistry.emitRestored(restored, 'relaunched');
        if (current.launch.harness === 'codex' && !current.agentSession) {
          scheduleCodexDiscovery(current.id, current.projectPath);
        }
      }
    },
  });
  done.catch(async (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    const current = await terminalRegistry.get(record.id, record.projectPath).catch(() => null);
    if (!current || current.ended) return;
    await terminalRegistry.end(current.id, { reason: 'restore-failed', detail: reason }, current.projectPath).catch(() => {});
    terminalRegistry.emitRestoreFailed(current, reason);
  });
}
