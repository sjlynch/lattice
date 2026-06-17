// Project-level Claude instrumentation: make ANY Claude session working in an
// opened project show up on the graph, not just the ones Lattice spawns.
//
//   POST /api/project-instrumentation { project }
//     Idempotently install (or, when the per-project setting is off, remove)
//     Lattice's activity hooks in <project>/.claude/settings.local.json.
//     Called by the frontend when a project is opened / the toggle changes.
//   POST /api/project-activity/:token
//     PreToolUse/PostToolUse/SessionStart/SessionEnd hook callback for those
//     sessions. Keyed by Claude's session_id (from the body), it drives the
//     same orange node + focus beams as the Lattice-spawned non-worktree
//     sessions (reuses agentSessions + agentActivity).

import { Router } from 'express';
import { canonicalProjectPath, latticeHomeDir } from '../projectPath.js';
import { getUserSettings } from '../userSettings.js';
import { ensureLatticeGitignore } from '../worktree.js';
import { ensureTrustedClaudeDir } from '../claudeTrust.js';
import {
  installProjectClaudeHooks,
  removeProjectClaudeHooks,
  setProjectClaudeMemoryDisabled,
} from '../projectClaudeHooks.js';
import {
  cwdFromHookBody,
  fileFromHookBody,
  hookEventName,
  phaseFromHookBody,
  sessionIdFromHookBody,
  toolFromHookBody,
} from '../claudeHookBody.js';
import { decodeAgentToken, notifyAgentActivity } from '../agentActivity.js';
import {
  registerAgentSession,
  touchAgentSession,
  unregisterAgentSession,
} from '../agentSessions.js';
import { mapFileToProject } from './agentActivity.js';

// A project session that goes quiet for this long is dropped — a safety net
// for a session that exits without firing SessionEnd (hard-killed terminal).
// SessionEnd is the primary, prompt removal signal; this is generous so a
// merely-idle (but alive) session doesn't flicker out.
const PROJECT_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;

// True when a hook's cwd belongs to a session Lattice already tracks through
// its own machinery (a worktree task agent, or a push/workflow/post-merge
// scratch session). Those must NOT also register here, or they'd get a
// duplicate node.
function isLatticeManagedCwd(cwd: string): boolean {
  const norm = cwd.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/.lattice/')) return true;
  const home = latticeHomeDir().replace(/\\/g, '/').toLowerCase();
  return norm.startsWith(home);
}

export function buildProjectClaudeRouter(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/project-instrumentation', async (req, res) => {
    const project =
      typeof req.body?.project === 'string' ? req.body.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    // Both default ON — absent settings count as enabled (opt-out model).
    const settings = await getUserSettings(project);
    const enabled = settings.instrumentProjectClaudeSessions !== false;
    const memoryDisabled = settings.disableClaudeMemory !== false;
    try {
      // Either feature writes <project>/.claude/settings.local.json; keep it
      // gitignored so it never shows up in the user's `git status`.
      if (enabled || memoryDisabled) {
        await ensureLatticeGitignore(canonicalProjectPath(project)).catch(() => {});
      }
      if (enabled) {
        // Pre-trust the dir so a launched session doesn't stall on the trust
        // dialog, then merge the activity hooks in.
        await ensureTrustedClaudeDir(canonicalProjectPath(project)).catch(() => {});
        await installProjectClaudeHooks(project, backendOrigin);
      } else {
        await removeProjectClaudeHooks(project);
      }
      // Independent of instrumentation: reconcile auto-memory for the project's
      // own Claude sessions (per-project, Local scope — never global).
      await setProjectClaudeMemoryDisabled(project, memoryDisabled);
    } catch (err) {
      console.warn('[project-instrumentation] failed:', err);
      return res.status(500).json({ error: (err as Error).message });
    }
    res.json({ ok: true, enabled, memoryDisabled });
  });

  r.post('/api/project-activity/:token', (req, res) => {
    // Always 204 — the session's curl ignores the body, and a hook must never
    // surface an error into the agent's tool call.
    const ack = () => res.status(204).end();
    const meta = decodeAgentToken(req.params.token);
    if (!meta) return ack();
    const body = req.body;
    const sessionId = sessionIdFromHookBody(body);
    if (!sessionId) return ack();
    const cwd = cwdFromHookBody(body);
    // Dedup: a worktree/scratch session is already tracked elsewhere.
    if (cwd && isLatticeManagedCwd(cwd)) return ack();

    const agentId = `claude:${sessionId}`;
    const event = hookEventName(body);

    if (event === 'SessionEnd') {
      unregisterAgentSession(agentId);
      return ack();
    }

    // SessionStart / PreToolUse / PostToolUse → ensure the node exists.
    // registerAgentSession is idempotent (refreshes liveness if present).
    registerAgentSession({
      agentId,
      projectPath: meta.projectPath,
      label: meta.label,
      idleTtlMs: PROJECT_SESSION_IDLE_TTL_MS,
    });
    touchAgentSession(agentId);
    if (event === 'SessionStart') return ack();

    // Tool use → focus beam.
    const rawFile = fileFromHookBody(body);
    if (!rawFile) return ack();
    const file = mapFileToProject(meta.projectPath, rawFile, cwd);
    if (!file) return ack();
    notifyAgentActivity({
      projectPath: meta.projectPath,
      agentId,
      label: meta.label,
      file,
      phase: phaseFromHookBody(body),
      tool: toolFromHookBody(body),
      ts: Date.now(),
    });
    return ack();
  });

  return r;
}
