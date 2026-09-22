// POST /api/agent-activity/:token — PreToolUse/PostToolUse hook callback for
// Claude sessions that run OUTSIDE a task worktree (push runs, workflow
// steps, post-merge hooks). The token (see agentActivityTokens.ts) carries
// the agent id, project, and label; the body is Claude's hook JSON. We map the
// touched file to a project-absolute path and emit an `agent-activity` event
// so the graph draws an orange Claude node + focus beam.

import path from 'node:path';
import { Router } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import { cwdFromHookBody, hookEventName } from '../claudeHookBody.js';
import { decodeActivityHook } from '../activityHook.js';
import { type AgentActivityEvent, notifyAgentActivity } from '../agentActivity.js';
import { decodeAgentToken } from '../agentActivityTokens.js';
import { touchAgentSession } from '../agentSessions.js';
import {
  noteAgentSignal,
  noteSubagentStart,
  noteSubagentStop,
} from '../agentQuiescence.js';
import { isManaged } from './tasks/activity.js';

// Map a file path from a non-worktree session's hook to the project-absolute
// path the scanner emits. These sessions act on the repo via absolute paths
// (or relative to their own cwd), so we resolve then require the result to
// sit inside the project root. Edits to scratch / managed files return null.
// Exported for the project-instrumentation route, which maps the same way.
export function mapFileToProject(
  projectPath: string,
  rawFile: string,
  hookCwd: string | null,
): string | null {
  const root = canonicalProjectPath(projectPath);
  const abs = path.isAbsolute(rawFile)
    ? rawFile
    : path.resolve(hookCwd ?? root, rawFile);
  const rel = path.relative(root, abs);
  // `..` as a whole SEGMENT is an escape; a file named `..foo` is not.
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  if (isManaged(rel)) return null;
  return path.join(root, rel);
}

// Build the `AgentActivityEvent` for a non-worktree Claude session, or null to
// drop. Shared verbatim by the agent-activity route (Lattice-spawned sessions)
// and the project-activity route (project-instrumented sessions) — they have
// the same notify payload and the same `mapFileToProject` mapping; only the
// `agentId` differs (the project route keys on `claude:<sessionId>`, not the
// token's agentId), so it's passed in explicitly. `cwd` resolves relative hook
// paths against the session's working directory.
export function buildAgentActivityEvent(
  meta: { projectPath: string; label: string },
  body: unknown,
  opts: { agentId: string; cwd: string | null },
): AgentActivityEvent | null {
  const result = decodeActivityHook(body, (raw) =>
    mapFileToProject(meta.projectPath, raw, opts.cwd),
  );
  if (!result) return null;
  const identity = {
    projectPath: meta.projectPath,
    agentId: opts.agentId,
    label: meta.label,
  };
  if (result.kind === 'lifecycle') {
    // Satellite appears/disappears on this session's node.
    return {
      ...identity,
      phase: 'start',
      tool: 'Task',
      ts: Date.now(),
      subagentId: result.subagentId,
      subagentType: result.subagentType,
      lifecycle: result.lifecycle,
    };
  }
  return {
    ...identity,
    file: result.file,
    phase: result.phase,
    tool: result.tool,
    ts: Date.now(),
    subagentId: result.subagentId,
    subagentType: result.subagentType,
  };
}

export function buildAgentActivityRouter(): Router {
  const r = Router();

  r.post('/api/agent-activity/:token', (req, res) => {
    // Always 204 — the session's curl ignores the body, and a hook must never
    // surface an error into the agent's tool call.
    const ack = () => res.status(204).end();
    const meta = decodeAgentToken(req.params.token);
    if (!meta) return ack();
    // Refresh liveness so an actively-emitting lifecycle session (push /
    // workflow step / post-merge hook) is never reaped mid-run by the
    // absolute-age backstop. registerAgentSession runs only once at spawn, so
    // without this the node's `lastSeen` stays frozen at `startedAt` and a
    // session that outlives MAX_AGE_MS — a substantial workflow step, a
    // browser-downloading QA run — loses its graph node while still active. A
    // no-op when the session is already gone (completed/swept): presence is
    // owned by the spawn + completion callbacks, so we never resurrect here.
    touchAgentSession(meta.agentId);
    // Feed the Stop-hook quiescence tracker. Two consumers key on it: workflow
    // steps (`wf:` — workflowRuns/stopHookGate.ts) and post-merge hooks
    // (`pmh:` — postMergeHooks/stopHookGate.ts); both gate a Claude Stop-hook
    // completion on the session going quiescent. EVERY hook is a "still alive"
    // signal, whether or not it yields a graph event: a workflow-step agent
    // spends much of its time on files the graph drops (its own
    // `.lattice/workflow-steps/…` dir, scratch outside the project), and gating
    // this on the graph event let the Stop-hook gate see a "quiet" session that
    // was still working. SubagentStart/Stop additionally move the live-subagent
    // count the gate uses to reject a Stop that fires while a subagent runs.
    if (meta.agentId.startsWith('wf:') || meta.agentId.startsWith('pmh:')) {
      const hookEvent = hookEventName(req.body);
      if (hookEvent === 'SubagentStart') noteSubagentStart(meta.agentId);
      else if (hookEvent === 'SubagentStop') noteSubagentStop(meta.agentId);
      else noteAgentSignal(meta.agentId);
    }
    const event = buildAgentActivityEvent(meta, req.body, {
      agentId: meta.agentId,
      cwd: cwdFromHookBody(req.body),
    });
    if (event) notifyAgentActivity(event);
    return ack();
  });

  return r;
}
