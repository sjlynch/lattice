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
import { applyClaudeProjectConfig } from '../claudeTrust.js';
import { resolveManagedClaudeServers } from '../mcp/registry.js';
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
  subagentIdFromHookBody,
  subagentTypeFromHookBody,
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
      // Reconcile the project's GLOBAL MCP servers (`mcpOverrides`, incl. the
      // Settings → MCP Playwright toggle) into the user's own project-root
      // `~/.claude.json` entry, so a `claude` the user starts themselves at the
      // project root — or a Lattice sidebar terminal (cwd = project root) — picks
      // them up in `/mcp`. This is the ONE place Lattice intentionally writes the
      // canonical project-root entry (everything else injects into ephemeral
      // worktree/scratch cwds); `reconcileMcpServers` only manages Lattice's own
      // servers (the `__latticeManagedMcp` marker), so the user's hand-added MCP
      // entries are never touched, and turning a global toggle off strips it back
      // out. Runs regardless of the instrumentation toggle, and `isQaRun` is left
      // false so the QA-only Playwright never lands here. Best-effort.
      // NB: Claude keys config by launch cwd, so this covers sessions started AT
      // the project root, not ones launched from a subdirectory.
      // `isQaRun: false` so the QA-only Playwright never lands in the root entry.
      const managed = await resolveManagedClaudeServers(project, { isQaRun: false });
      await applyClaudeProjectConfig(canonicalProjectPath(project), { managed });
      if (enabled) {
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

    const subagentId = subagentIdFromHookBody(body);
    const subagentType = subagentTypeFromHookBody(body) ?? undefined;

    // Subagent lifecycle → satellite appears/disappears on this session's node.
    if (event === 'SubagentStart' || event === 'SubagentStop') {
      if (subagentId) {
        notifyAgentActivity({
          projectPath: meta.projectPath,
          agentId,
          label: meta.label,
          phase: 'start',
          tool: 'Task',
          ts: Date.now(),
          subagentId,
          subagentType,
          lifecycle: event === 'SubagentStart' ? 'spawn' : 'stop',
        });
      }
      return ack();
    }

    // Tool use → focus beam (on the satellite when `subagentId` is set).
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
      subagentId: subagentId ?? undefined,
      subagentType,
    });
    return ack();
  });

  return r;
}
