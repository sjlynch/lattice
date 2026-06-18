// POST /api/agent-activity/:token — PreToolUse/PostToolUse hook callback for
// Claude sessions that run OUTSIDE a task worktree (push runs, workflow
// steps, post-merge hooks). The token (see agentActivity.ts) carries the
// agent id, project, and label; the body is Claude's hook JSON. We map the
// touched file to a project-absolute path and emit an `agent-activity` event
// so the graph draws an orange Claude node + focus beam.

import path from 'node:path';
import { Router } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import {
  cwdFromHookBody,
  fileFromHookBody,
  hookEventName,
  phaseFromHookBody,
  subagentIdFromHookBody,
  subagentTypeFromHookBody,
  toolFromHookBody,
} from '../claudeHookBody.js';
import { decodeAgentToken, notifyAgentActivity } from '../agentActivity.js';
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
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (isManaged(rel)) return null;
  return path.join(root, rel);
}

export function buildAgentActivityRouter(): Router {
  const r = Router();

  r.post('/api/agent-activity/:token', (req, res) => {
    // Always 204 — the session's curl ignores the body, and a hook must never
    // surface an error into the agent's tool call.
    const ack = () => res.status(204).end();
    const meta = decodeAgentToken(req.params.token);
    if (!meta) return ack();

    const event = hookEventName(req.body);
    const subagentId = subagentIdFromHookBody(req.body);
    const subagentType = subagentTypeFromHookBody(req.body) ?? undefined;

    // Subagent lifecycle → satellite appears/disappears on this session's node.
    if (event === 'SubagentStart' || event === 'SubagentStop') {
      if (!subagentId) return ack();
      notifyAgentActivity({
        projectPath: meta.projectPath,
        agentId: meta.agentId,
        label: meta.label,
        phase: 'start',
        tool: 'Task',
        ts: Date.now(),
        subagentId,
        subagentType,
        lifecycle: event === 'SubagentStart' ? 'spawn' : 'stop',
      });
      return ack();
    }

    const rawFile = fileFromHookBody(req.body);
    if (!rawFile) return ack();
    const file = mapFileToProject(meta.projectPath, rawFile, cwdFromHookBody(req.body));
    if (!file) return ack();

    notifyAgentActivity({
      projectPath: meta.projectPath,
      agentId: meta.agentId,
      label: meta.label,
      file,
      phase: phaseFromHookBody(req.body),
      tool: toolFromHookBody(req.body),
      ts: Date.now(),
      subagentId: subagentId ?? undefined,
      subagentType,
    });
    return ack();
  });

  return r;
}
