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
import {
  ensurePiSubagentsInstalled,
  getPiSubagentsEntry,
  installPiSubagentsShim,
} from '../piSubagents.js';
import { applyClaudeProjectConfig } from '../claudeTrust.js';
import { resolveManagedClaudeServers } from '../mcp/registry.js';
import {
  installProjectClaudeHooks,
  removeProjectClaudeHooks,
  setProjectClaudeMemoryDisabled,
} from '../projectClaudeHooks.js';
import {
  cwdFromHookBody,
  hookEventName,
  sessionIdFromHookBody,
} from '../claudeHookBody.js';
import { notifyAgentActivity } from '../agentActivity.js';
import { decodeAgentToken } from '../agentActivityTokens.js';
import {
  registerAgentSession,
  touchAgentSession,
  unregisterAgentSession,
} from '../agentSessions.js';
import { buildAgentActivityEvent } from './agentActivity.js';

// A project session that goes quiet for this long is dropped — a safety net
// for a session that exits without firing SessionEnd (hard-killed terminal).
// SessionEnd is the primary, prompt removal signal; this is generous so a
// merely-idle (but alive) session doesn't flicker out.
const PROJECT_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;

// After a session's SessionEnd we briefly remember its session_id so a hook
// that arrives AFTER SessionEnd can't resurrect the node. Each Claude hook is
// an independent `curl -m 2` with no ordering guarantee, so a final PostToolUse
// (or a reordered SessionStart) can land after SessionEnd; the curl gives up
// after 2s, so any straggler arrives well within this window. Generous so a
// late hook never slips past it.
const RECENTLY_ENDED_TTL_MS = 30 * 1000;
const recentlyEndedAt = new Map<string, number>();

type ProjectInstrumentationResult = {
  enabled: boolean;
  memoryDisabled: boolean;
};

function rememberEndedSession(sessionId: string): void {
  const now = Date.now();
  recentlyEndedAt.set(sessionId, now);
  // Prune expired ids so the map stays bounded to recent session churn.
  for (const [id, ts] of recentlyEndedAt) {
    if (now - ts > RECENTLY_ENDED_TTL_MS) recentlyEndedAt.delete(id);
  }
}

function recentlyEnded(sessionId: string): boolean {
  const ts = recentlyEndedAt.get(sessionId);
  if (ts === undefined) return false;
  if (Date.now() - ts > RECENTLY_ENDED_TTL_MS) {
    recentlyEndedAt.delete(sessionId);
    return false;
  }
  return true;
}

// Apply one project-instrumented session's lifecycle/activity event to the
// presence registry and report whether the caller should emit a focus-beam
// activity event for it. Presence is owned by SessionStart (create) and
// SessionEnd (remove) ONLY; tool-use / subagent events are refresh-only via
// touchAgentSession — a no-op once the session is gone. This mirrors
// routes/agentActivity.ts ('presence is owned by the spawn + completion
// callbacks, so we never resurrect here') and fixes the asymmetry where this
// route used to registerAgentSession (which CREATES) on every non-SessionEnd
// event: a late PostToolUse after SessionEnd resurrected a ghost node that then
// lingered for the full PROJECT_SESSION_IDLE_TTL_MS. The recentlyEnded guard
// additionally drops a reordered SessionStart for an already-ended session,
// which touch-only alone wouldn't catch. Exported for the regression test.
export function applyProjectActivityEvent(args: {
  event: string;
  sessionId: string;
  agentId: string;
  projectPath: string;
  label: string;
}): { emitActivity: boolean } {
  const { event, sessionId, agentId } = args;

  if (event === 'SessionEnd') {
    unregisterAgentSession(agentId);
    rememberEndedSession(sessionId);
    return { emitActivity: false };
  }

  // A hook reordered after this session's SessionEnd must not bring the node
  // back — drop every event for a just-ended session_id, SessionStart included.
  if (recentlyEnded(sessionId)) return { emitActivity: false };

  if (event === 'SessionStart') {
    // SessionStart is the only event that may CREATE the node (no matcher, so
    // it fires reliably at session start). registerAgentSession is idempotent.
    registerAgentSession({
      agentId,
      projectPath: args.projectPath,
      label: args.label,
      idleTtlMs: PROJECT_SESSION_IDLE_TTL_MS,
    });
    return { emitActivity: false };
  }

  // PreToolUse / PostToolUse / SubagentStart / SubagentStop → refresh liveness
  // only. touchAgentSession returns false (and creates nothing) when the
  // session is gone, so a stray post-SessionEnd hook is a no-op; with no node
  // to anchor it we also skip the focus-beam emit.
  if (!touchAgentSession(agentId)) return { emitActivity: false };
  return { emitActivity: true };
}

async function reconcileProjectInstrumentation(
  project: string,
  backendOrigin: string,
): Promise<ProjectInstrumentationResult> {
  // Both default ON — absent settings count as enabled (opt-out model).
  const settings = await getUserSettings(project);
  const enabled = settings.instrumentProjectClaudeSessions !== false;
  const memoryDisabled = settings.disableClaudeMemory !== false;
  const root = canonicalProjectPath(project);

  // Either feature writes <project>/.claude/settings.local.json; keep it
  // gitignored so it never shows up in the user's `git status`.
  if (enabled || memoryDisabled) {
    await ensureLatticeGitignore(root).catch(() => {});
  }

  await reconcileProjectClaudeMcp(root, project);
  await reconcileProjectClaudeHooks(project, backendOrigin, enabled);
  await setProjectClaudeMemoryDisabled(project, memoryDisabled);
  installProjectPiSubagentsShim(root);

  return { enabled, memoryDisabled };
}

async function reconcileProjectClaudeMcp(
  root: string,
  project: string,
): Promise<void> {
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
  const managed = await resolveManagedClaudeServers(project, { isQaRun: false });
  await applyClaudeProjectConfig(root, { managed });
}

async function reconcileProjectClaudeHooks(
  project: string,
  backendOrigin: string,
  enabled: boolean,
): Promise<void> {
  if (enabled) {
    await installProjectClaudeHooks(project, backendOrigin);
  } else {
    await removeProjectClaudeHooks(project);
  }
}

function installProjectPiSubagentsShim(root: string): void {
  // pi-subagents (best-effort, non-blocking): ensure the shared install,
  // then drop the loader shim at the project ROOT so a `pi` the user starts
  // in the Lattice terminal panel (cwd = project root) gets sub-agents — Pi
  // extension discovery is cwd-exact, so this is the only way to reach a
  // manually-typed `pi`. Backgrounded so a cold first-time install (~20s)
  // doesn't delay this response; the shim still lands once it resolves.
  void ensurePiSubagentsInstalled()
    .then(async () => {
      if (!getPiSubagentsEntry()) return;
      await ensureLatticeGitignore(root).catch(() => {});
      await installPiSubagentsShim({ dir: root }).catch(() => {});
    })
    .catch(() => {});
}

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

function applyProjectActivityHook(token: string, body: unknown): void {
  const meta = decodeAgentToken(token);
  if (!meta) return;
  const sessionId = sessionIdFromHookBody(body);
  if (!sessionId) return;
  const cwd = cwdFromHookBody(body);
  // Dedup: a worktree/scratch session is already tracked elsewhere.
  if (cwd && isLatticeManagedCwd(cwd)) return;

  const agentId = `claude:${sessionId}`;
  const event = hookEventName(body);

  // Presence (create on SessionStart, remove on SessionEnd, refresh-only
  // otherwise). A late hook after SessionEnd never resurrects the node.
  const { emitActivity } = applyProjectActivityEvent({
    event,
    sessionId,
    agentId,
    projectPath: meta.projectPath,
    label: meta.label,
  });
  if (!emitActivity) return;

  // Subagent lifecycle (satellite spawn/stop) or tool-use (focus beam) — the
  // same decode as the other two activity routes, keyed on this session's
  // `claude:<sessionId>` agent id rather than the token's.
  const activity = buildAgentActivityEvent(meta, body, { agentId, cwd });
  if (activity) notifyAgentActivity(activity);
}

export function buildProjectClaudeRouter(backendOrigin: string): Router {
  const r = Router();

  r.post('/api/project-instrumentation', async (req, res) => {
    const project =
      typeof req.body?.project === 'string' ? req.body.project : '';
    if (!project) return res.status(400).json({ error: 'project required' });
    try {
      const result = await reconcileProjectInstrumentation(project, backendOrigin);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.warn('[project-instrumentation] failed:', err);
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  r.post('/api/project-activity/:token', (req, res) => {
    // Always 204 — the session's curl ignores the body, and a hook must never
    // surface an error into the agent's tool call.
    applyProjectActivityHook(req.params.token, req.body);
    return res.status(204).end();
  });

  return r;
}
