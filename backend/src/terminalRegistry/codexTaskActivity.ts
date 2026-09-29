// Display-only fallback for task Codex sessions using the hosted JS runner.
// Reuses the registry's pinned conversation and its existing live-PTY poll;
// never scans for arbitrary sessions, changes task state, or touches a PTY.
import fs from 'node:fs/promises';
import type { CodexCodeTool } from '../codexCodeActivity.js';
import { MAX_FILES_PER_TOOL_USE } from '../hookFiles.js';
import { decodeTaskActivity } from '../routes/tasks/activity.js';
import { notifyTaskActivity } from '../taskActivityEvents.js';
import { getTask } from '../tasks.js';
import { normalizeCwd } from './harnessPaths.js';
import { findCodexRolloutFile } from './sessionFiles.js';
import { terminalRegistry } from './store.js';
import type { TerminalRecord } from './types.js';
import type { LiveSessionsView } from './watch.js';

const MAX_READ_BYTES = 256 * 1024;
const FILE_RETRY_MS = 15_000;

type Cursor = {
  sessionId: string;
  serverId: string;
  serverInstanceId: string | undefined;
  restoredAt: number | undefined;
  file: string | null;
  retryAt: number;
  offset: number;
  pending: Map<string, CodexCodeTool[]>;
};
const cursors = new Map<string, Cursor>();

export function sameCodexActivitySession(
  a: Pick<TerminalRecord, 'serverId' | 'serverInstanceId' | 'agentSession' | 'restoredAt'>,
  b: Pick<TerminalRecord, 'serverId' | 'serverInstanceId' | 'agentSession' | 'restoredAt'>,
): boolean {
  return a.serverId === b.serverId && a.serverInstanceId === b.serverInstanceId
    && a.agentSession?.id === b.agentSession?.id
    && a.agentSession?.harness === b.agentSession?.harness && a.restoredAt === b.restoredAt;
}

// Bounded tail on first attachment; incremental complete lines thereafter.
// Keep a partially written UTF-8 line on disk until its final newline arrives.
export async function readCodexActivityLines(file: string, offset: number): Promise<{ lines: string[]; offset: number }> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size === offset) return { lines: [], offset };
    const floor = offset > size ? 0 : offset;
    const start = Math.max(floor, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, bytesRead);
    const lastNewline = bytes.lastIndexOf(10);
    // A single oversized row must not pin the reader on that row forever.
    if (lastNewline < 0) return { lines: [], offset: start > floor ? size : floor };
    const first = start > floor ? bytes.indexOf(10) + 1 : 0;
    return {
      lines: bytes.subarray(first, lastNewline + 1).toString('utf8').split('\n').filter(Boolean),
      offset: start + lastNewline + 1,
    };
  } finally {
    await handle.close();
  }
}

export async function pollCodexTaskActivity(live: LiveSessionsView): Promise<void> {
  const records = terminalRegistry.loadedRecords().filter(({ record: r }) =>
    !r.ended && !r.closePending && (r.owner === 'task' || r.owner === 'merge') && r.taskId
    && r.serverId && live.serverIds.has(r.serverId) && r.agentSession?.harness === 'codex'
    && !r.agentSession.ambiguous,
  );
  const activeIds = new Set(records.map(({ record }) => record.id));
  for (const id of cursors.keys()) if (!activeIds.has(id)) cursors.delete(id);
  // Each reader is independent; a locked/missing transcript cannot delay or
  // fail the registry's exit reconciliation or another task's activity.
  await Promise.all(records.map(async ({ projectKey, record }) => {
    try {
      await pollRecord(projectKey, record);
    } catch {
      // Advisory telemetry only. Retry the same cursor on the next live poll.
    }
  }));
}

async function pollRecord(projectKey: string, record: TerminalRecord): Promise<void> {
  const sessionId = record.agentSession!.id;
  let cursor = cursors.get(record.id);
  if (!cursor || cursor.sessionId !== sessionId || cursor.serverId !== record.serverId
    || cursor.serverInstanceId !== record.serverInstanceId
    || cursor.restoredAt !== record.restoredAt) {
    cursor = { sessionId, serverId: record.serverId!, serverInstanceId: record.serverInstanceId,
      restoredAt: record.restoredAt,
      file: null, retryAt: 0, offset: 0, pending: new Map() };
    cursors.set(record.id, cursor);
  }
  if (!cursor.file) {
    if (Date.now() < cursor.retryAt) return;
    cursor.retryAt = Date.now() + FILE_RETRY_MS;
    cursor.file = await findCodexRolloutFile(sessionId);
    if (!cursor.file) return;
  }
  let chunk: Awaited<ReturnType<typeof readCodexActivityLines>>;
  try {
    chunk = await readCodexActivityLines(cursor.file, cursor.offset);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') cursor.file = null;
    throw err;
  }
  if (chunk.offset < cursor.offset) cursor.pending.clear();
  if (chunk.lines.length === 0) {
    cursor.offset = chunk.offset;
    return;
  }
  // Load the JS parser only for sessions that actually record hosted calls.
  const codeReader = chunk.lines.some((line) => line.includes('"custom_tool_call"') && line.includes('"exec"'))
    ? await import('../codexCodeActivity.js') : null;
  const task = await getTask(record.taskId!);
  // Re-check identity after disk I/O: restore/close may have replaced this
  // record's PTY while the old transcript was being read.
  const current = await terminalRegistry.get(record.id, projectKey);
  if (!current || current.ended || current.closePending || current.agentSession?.ambiguous
    || current.taskId !== record.taskId || current.owner !== record.owner
    || normalizeCwd(current.cwd) !== normalizeCwd(record.cwd)
    || !sameCodexActivitySession(record, current)) return;
  if (!task || task.status !== 'in_progress' || !task.worktreePath
    || normalizeCwd(task.worktreePath) !== normalizeCwd(record.cwd)
    || normalizeCwd(task.projectPath) !== normalizeCwd(record.projectPath)) return;
  cursor.offset = chunk.offset;
  const since = record.restoredAt ?? record.createdAt;
  for (const line of chunk.lines) {
    let row: { timestamp?: string; type?: string; payload?: { type?: string; call_id?: string } };
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== 'object' || typeof row.timestamp !== 'string') continue;
    const timestamp = Date.parse(row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < since) continue;
    const call = codeReader?.codexRolloutCodeCall(row);
    let tools = call?.tools;
    if (call) {
      cursor.pending.set(call.id, call.tools);
      if (cursor.pending.size > 128) cursor.pending.delete(cursor.pending.keys().next().value!);
    } else if (row.type === 'response_item' && row.payload?.type === 'custom_tool_call_output' && row.payload.call_id) {
      // A patch's Add target may not exist when the call is recorded. Retry its
      // literal paths when the result is recorded; native hooks do the same.
      tools = cursor.pending.get(row.payload.call_id);
      cursor.pending.delete(row.payload.call_id);
    }
    const emitted = new Set<string>();
    for (const tool of tools ?? []) {
      if (emitted.size >= MAX_FILES_PER_TOOL_USE) break;
      const result = decodeTaskActivity(task, { ...tool, cwd: record.cwd, hook_event_name: 'PreToolUse' });
      if (result?.kind !== 'tool') continue;
      for (const file of result.files) {
        if (emitted.size >= MAX_FILES_PER_TOOL_USE) break;
        if (emitted.has(file)) continue;
        emitted.add(file);
        notifyTaskActivity({ projectPath: task.projectPath, taskId: task.id, file,
          phase: 'start', tool: result.tool, ts: Date.now() });
      }
    }
  }
}
