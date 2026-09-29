// The RELAUNCH half of a restore pass (`restore.ts` decides which records get
// one): queue a dead tab's respawn into its previous conversation through the
// spawn queue, and report the outcome as a `restored` / `restore-failed` event.

import { notifySessionsFreed, SpawnCapacityError } from '../spawnQueue.js';
import type { UserSettings } from '../userSettings.js';
import type { InterruptionVerdict } from './interruption.js';
import { buildRestoreCommand, RESTORE_NUDGE } from './restoreCommand.js';
import { terminalRegistry } from './store.js';
import type { AgentSessionRef, TerminalRecord } from './types.js';
import { scheduleCodexDiscovery } from './codexDiscovery.js';
import type { RestoreDeps } from './restore.js';

// The nudge decision plus (for Claude) the transcript-exists fact, from ONE
// read of the harness's files.
export async function planRelaunch(
  record: TerminalRecord,
  deps: RestoreDeps,
): Promise<{ nudge?: string; transcriptExists: boolean; agentSession?: AgentSessionRef }> {
  const settings: UserSettings = await deps.getUserSettings(record.projectPath).catch(() => ({}));
  const needsVerdict = record.agentSession?.harness === 'claude'
    || (record.owner === 'user' && settings.restoreNudgeUserTabs === true);
  let verdict: InterruptionVerdict | null = null;
  if (needsVerdict) {
    try { verdict = await deps.detectInterruption(record); } catch { verdict = null; }
  }
  let nudge: string | undefined;
  if (record.owner === 'task' || record.owner === 'merge') {
    nudge = settings.restoreNudgeAgents === false ? undefined : RESTORE_NUDGE;
  } else if (record.owner === 'user' && settings.restoreNudgeUserTabs === true) {
    nudge = verdict?.interruption === 'interrupted' ? RESTORE_NUDGE : undefined;
  }
  return {
    nudge,
    transcriptExists: verdict?.transcriptExists === true,
    ...(verdict?.agentSession ? { agentSession: verdict.agentSession } : {}),
  };
}

// A live Codex tab whose thread id was never learned (its discovery poll died
// with the previous backend process) keeps looking, so a later relaunch can
// resume it by id instead of `resume --last`.
export function scheduleDiscoveryIfUnknown(record: TerminalRecord): void {
  if (record.launch.harness === 'codex' && !record.agentSession) {
    scheduleCodexDiscovery(record.id, record.projectPath);
  }
}

// Clear `relaunching`, end the record as `restore-failed` (keeping the FIRST
// failure time), and tell the clients. `bestEffort` swallows each registry
// write's error (the thunk-rejection path); otherwise a write error propagates
// out of the thunk.
async function markRelaunchFailed(
  record: TerminalRecord,
  reason: string,
  firstFailedAt: number | undefined,
  { bestEffort }: { bestEffort: boolean },
): Promise<void> {
  const guard = <T>(p: Promise<T>): Promise<T | undefined> => (bestEffort ? p.catch(() => undefined) : p);
  await guard(terminalRegistry.update(record.id, { relaunching: undefined }, record.projectPath));
  await guard(terminalRegistry.end(
    record.id, { reason: 'restore-failed', detail: reason, at: firstFailedAt }, record.projectPath,
  ));
  terminalRegistry.emitRestoreFailed(record, reason);
}

export function enqueueRelaunch(record: TerminalRecord, deps: RestoreDeps): Promise<void> {
  // A retried failure keeps its FIRST failure time when it fails again, so the
  // retention prune counts from the original failure, not the latest retry.
  const firstFailedAt = record.ended?.reason === 'restore-failed' ? record.ended.at : undefined;
  const { done } = deps.enqueue<void>({
    kind: 'terminal-restore',
    priority: 'batch',
    dedupeKey: `terminal-restore:${record.id}`,
    thunk: async () => {
      const current = await terminalRegistry.get(record.id, record.projectPath);
      // Closed while queued, or already backed by a pty again (another pass
      // adopted / relaunched it in the meantime): nothing to spawn.
      if (!current || current.ended || current.serverId) {
        if (current?.relaunching) {
          await terminalRegistry.update(current.id, { relaunching: undefined }, current.projectPath).catch(() => null);
        }
        return;
      }
      // A Codex tab that died before its discovery poll caught the rollout:
      // one last look now, so the relaunch resumes the thread by id rather
      // than `resume --last` (the newest thread in the folder — possibly
      // another tab's).
      if (current.launch.harness === 'codex' && !current.agentSession) {
        await deps.discoverCodexSession(current.id, current.projectPath).catch(() => false);
      }
      const latest = await terminalRegistry.get(current.id, current.projectPath) ?? current;
      const plan = await planRelaunch(latest, deps);
      const beforeSpawn = await terminalRegistry.get(current.id, current.projectPath);
      if (!beforeSpawn || beforeSpawn.ended || beforeSpawn.serverId) {
        if (beforeSpawn?.relaunching) {
          await terminalRegistry.update(current.id, { relaunching: undefined }, current.projectPath);
        }
        return;
      }
      const built = buildRestoreCommand({
        launch: current.launch,
        // A conversation the detector re-learned wins over the pinned id; the
        // relaunch records it (registry.agentSession below) for next time.
        agentSession: plan.agentSession ?? latest.agentSession,
        claudeTranscriptExists: plan.transcriptExists,
        nudge: plan.nudge,
      });
      const sess = await deps.createSession({
        cwd: current.cwd,
        initialCommand: built.command,
        projectPath: current.projectPath,
        isQaRun: current.launch.isQaRun,
        taskId: current.launch.taskId,
        mcpScope: current.launch.mcpScope,
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
        await markRelaunchFailed(current, sess.error, firstFailedAt, { bestEffort: false });
        return;
      }
      const restored = await terminalRegistry.get(current.id, current.projectPath);
      // The tab was closed (record ended / removed) while the spawn was in
      // flight. A close tombstone owns the late PTY until its cleanup succeeds;
      // legacy callers may already have removed the record entirely.
      if (!restored || restored.ended || restored.serverId !== sess.id) {
        const killed = await deps.killSession(sess.id).catch(() => false);
        if (killed) {
          notifySessionsFreed();
          if (restored?.closePending && restored.serverId === sess.id) {
            await terminalRegistry.end(restored.id, { reason: 'closed' }, restored.projectPath);
          }
        }
        return;
      }
      terminalRegistry.emitRestored(restored, 'relaunched');
      if (current.launch.harness === 'codex' && !built.agentSession) {
        scheduleCodexDiscovery(current.id, current.projectPath);
      }
    },
  });
  return done.catch(async (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    const current = await terminalRegistry.get(record.id, record.projectPath).catch(() => null);
    if (!current || current.ended) return;
    await markRelaunchFailed(current, reason, firstFailedAt, { bestEffort: true });
  });
}
