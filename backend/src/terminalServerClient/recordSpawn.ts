import { agentHarnessForCommand } from '../harnesses.js';
import { terminalRegistry } from '../terminalRegistry/store.js';
import { endSupersededStartupRecords } from '../terminalRegistry/startupSupersede.js';
import type { AgentSessionRef, TerminalRecord, TerminalRegistryHint } from '../terminalRegistry/types.js';
import type { CreateSessionOptions } from './spawnBody.js';

// Derive the registry record for a freshly created pty and persist it. The
// ORIGINAL command is stored (not the identity-injected one) so a relaunch
// re-enters the chokepoint cleanly. Best-effort: a registry failure never
// fails the spawn — the pty exists and must be returned.
export async function recordSpawnedTerminal(
  opts: CreateSessionOptions,
  originalCommand: string | undefined,
  serverId: string,
  serverInstanceId: string | undefined,
  agentSession: AgentSessionRef | undefined,
): Promise<TerminalRecord | null> {
  if (!opts.cwd) return null;
  const hint: TerminalRegistryHint = opts.registry ?? { owner: 'user' };
  const harness = agentHarnessForCommand(originalCommand) ?? undefined;
  const projectPath = opts.projectPath ?? opts.cwd;
  const launch: TerminalRecord['launch'] = {
    ...(originalCommand ? { initialCommand: originalCommand } : {}),
    ...(harness ? { harness } : {}),
    ...(hint.piModel ? { piModel: hint.piModel } : {}),
    ...(opts.isQaRun ? { isQaRun: true } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.mcpScope ? { mcpScope: opts.mcpScope } : {}),
  };
  const session = agentSession ?? hint.agentSession;
  try {
    if (hint.existingId) {
      // A relaunch. The record keeps its ORIGINAL launch (the command it was
      // first created with) — the relaunch command (`--resume <id>`,
      // `resume <id>`, …) is derived from it every time and must never
      // replace it, or the next restore would try to resume a resume.
      const prev = await terminalRegistry.get(hint.existingId, projectPath);
      const restoredAt = Date.now();
      return await terminalRegistry.recordRelaunch(hint.existingId, {
        serverId,
        serverInstanceId,
        ...(session ? { agentSession: session } : {}),
        ended: undefined,
        restoredAt,
        // Keep an adopted Codex tab's thread-creation floor, but a later
        // resume --last must look for the file being written by THIS spawn.
        ...(prev?.codexDiscovery ? {
          codexDiscovery: session ? undefined : { ...prev.codexDiscovery, writtenSince: restoredAt, mode: 'resumed' },
        } : {}),
        restoreCount: (prev?.restoreCount ?? 0) + 1,
        lastBusy: undefined,
        relaunching: undefined,
      }, projectPath);
    }
    const label = hint.label ?? defaultTerminalLabel(originalCommand, harness);
    const record = await terminalRegistry.create({
      projectPath,
      cwd: opts.cwd,
      label,
      owner: hint.owner,
      launch,
      ...(hint.kind ? { kind: hint.kind } : {}),
      ...(hint.taskId ? { taskId: hint.taskId } : {}),
      ...(hint.startupId ? { startupId: hint.startupId } : {}),
      ...(session ? { agentSession: session } : {}),
      serverId,
      ...(serverInstanceId ? { serverInstanceId } : {}),
    });
    // A re-seeded startup terminal replaces its dead predecessor's tab, whatever
    // the restore mode (restore is otherwise the only thing that ends it).
    await endSupersededStartupRecords(terminalRegistry, record, serverInstanceId).catch((err) => {
      console.warn('[terminal-registry] could not end superseded startup terminal:', err);
    });
    return record;
  } catch (err) {
    console.warn('[terminal-registry] could not record spawned terminal:', err);
    return null;
  }
}

function defaultTerminalLabel(command: string | undefined, harness: string | undefined): string {
  if (harness) return harness;
  if (!command) return 'terminal';
  const first = command.trim().split(/\s+/)[0] ?? 'terminal';
  return first.length > 18 ? first.slice(0, 17) + '…' : first;
}
