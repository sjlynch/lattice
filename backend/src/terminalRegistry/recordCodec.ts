// The untrusted-file codec for `terminals.json` (store.ts re-exports both
// deserializers). Every field is re-validated: the file is untrusted input (a
// crash mid-write, a hand edit). A record missing anything load-bearing is
// dropped, not "repaired" into a tab that would relaunch the wrong thing.

import { isAgentHarness } from '../harnesses.js';
import type {
  AgentSessionSource,
  TerminalEndReason,
  TerminalOwner,
  TerminalRecord,
} from './types.js';

export const ENDED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const AGENT_SESSION_SOURCES: ReadonlySet<AgentSessionSource> = new Set<AgentSessionSource>([
  'minted', 'rollout-scan', 'transcript-scan', 'command',
]);

export const OWNERS: ReadonlySet<string> = new Set<TerminalOwner>([
  'user', 'task', 'merge', 'startup', 'workflow-step', 'push', 'qa',
  'post-merge', 'prompt-customization',
]);
export const END_REASONS: ReadonlySet<string> = new Set<TerminalEndReason>([
  'exit', 'closed', 'killed', 'owner-finished', 'cwd-missing', 'restore-failed',
]);

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? v as Record<string, unknown> : undefined;
}

function parseLaunch(v: unknown): TerminalRecord['launch'] {
  const raw = asObject(v) ?? {};
  const launch: TerminalRecord['launch'] = {};
  const initialCommand = str(raw.initialCommand);
  if (initialCommand) launch.initialCommand = initialCommand;
  if (isAgentHarness(raw.harness)) launch.harness = raw.harness;
  const piModel = str(raw.piModel);
  if (piModel) launch.piModel = piModel;
  if (raw.isQaRun === true) launch.isQaRun = true;
  const taskId = str(raw.taskId);
  if (taskId) launch.taskId = taskId;
  if (raw.mcpScope === 'task-worktree') launch.mcpScope = 'task-worktree';
  return launch;
}

function parseCodexDiscovery(v: unknown): TerminalRecord['codexDiscovery'] {
  const d = asObject(v);
  if (!d) return undefined;
  const createdSince = num(d.createdSince);
  const writtenSince = num(d.writtenSince);
  if (createdSince === undefined || createdSince < 0) return undefined;
  if (writtenSince === undefined || writtenSince < 0) return undefined;
  const mode = d.mode;
  if (mode !== 'fresh' && mode !== 'resumed') return undefined;
  return { createdSince, writtenSince, mode };
}

// A relaunch that was in flight when the process died is not in flight now.
// (Deliberately not persisted-through: the flag only means anything for the
// backend process that queued it.)
function parseAgentSession(v: unknown): TerminalRecord['agentSession'] {
  const as = asObject(v);
  if (!as || !isAgentHarness(as.harness)) return undefined;
  const id = str(as.id);
  if (!id) return undefined;
  return {
    harness: as.harness,
    id,
    source: AGENT_SESSION_SOURCES.has(as.source as AgentSessionSource)
      ? as.source as AgentSessionSource
      : 'minted',
    ...(as.ambiguous === true ? { ambiguous: true } : {}),
  };
}

function parseLastBusy(v: unknown): TerminalRecord['lastBusy'] {
  const lb = asObject(v);
  if (!lb) return undefined;
  const busy = lb.busy;
  if (typeof busy !== 'boolean') return undefined;
  const at = num(lb.at);
  return at === undefined ? undefined : { busy, at };
}

function parseEnded(v: unknown): TerminalRecord['ended'] {
  const ended = asObject(v);
  if (!ended) return undefined;
  const reason = str(ended.reason);
  if (!reason || !END_REASONS.has(reason)) return undefined;
  const exitCode = num(ended.exitCode);
  const detail = str(ended.detail);
  return {
    at: num(ended.at) ?? Date.now(),
    reason: reason as TerminalEndReason,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(detail ? { detail } : {}),
  };
}

export function deserializeTerminalRecord(raw: unknown): TerminalRecord | null {
  const r = asObject(raw);
  if (!r) return null;
  const id = str(r.id);
  const projectPath = str(r.projectPath);
  const cwd = str(r.cwd);
  const owner = str(r.owner);
  if (!id || !projectPath || !cwd || !owner || !OWNERS.has(owner)) return null;
  const record: TerminalRecord = {
    id,
    projectPath,
    cwd,
    label: str(r.label) ?? id,
    order: num(r.order) ?? 0,
    owner: owner as TerminalOwner,
    launch: parseLaunch(r.launch),
    createdAt: num(r.createdAt) ?? Date.now(),
    updatedAt: num(r.updatedAt) ?? Date.now(),
  };
  if (r.kind === 'merge' || r.kind === 'startup') record.kind = r.kind;
  const taskId = str(r.taskId);
  if (taskId) record.taskId = taskId;
  const startupId = str(r.startupId);
  if (startupId) record.startupId = startupId;
  const serverId = str(r.serverId);
  if (serverId) record.serverId = serverId;
  const serverInstanceId = str(r.serverInstanceId);
  if (serverInstanceId) record.serverInstanceId = serverInstanceId;
  const restoreCount = num(r.restoreCount);
  if (restoreCount !== undefined) record.restoreCount = restoreCount;
  const restoredAt = num(r.restoredAt);
  if (restoredAt !== undefined) record.restoredAt = restoredAt;
  const codexDiscovery = parseCodexDiscovery(r.codexDiscovery);
  if (codexDiscovery) record.codexDiscovery = codexDiscovery;
  const agentSession = parseAgentSession(r.agentSession);
  if (agentSession) record.agentSession = agentSession;
  const lastBusy = parseLastBusy(r.lastBusy);
  if (lastBusy) record.lastBusy = lastBusy;
  const ended = parseEnded(r.ended);
  if (ended) record.ended = ended;
  if (r.closePending === true && ended?.reason === 'closed') record.closePending = true;
  return record;
}

export function deserializeTerminalRecords(raw: unknown): TerminalRecord[] | null {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { terminals?: unknown }).terminals)
      ? (raw as { terminals: unknown[] }).terminals
      : null;
  if (!list) return null;
  const now = Date.now();
  const out: TerminalRecord[] = [];
  for (const item of list) {
    const rec = deserializeTerminalRecord(item);
    if (!rec) continue;
    // Prune long-ended leftovers so the file can't grow forever.
    if (rec.ended && !rec.closePending && now - rec.ended.at > ENDED_RETENTION_MS) continue;
    out.push(rec);
  }
  return out.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}
