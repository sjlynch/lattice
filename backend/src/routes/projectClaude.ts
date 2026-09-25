// Project-level Claude instrumentation: make ANY Claude session working in an
// opened project show up on the graph, not just the ones Lattice spawns.
//
//   POST /api/project-instrumentation { project }
//     Idempotently install (or, when the per-project setting is off, remove)
//     Lattice's activity hooks in <project>/.claude/settings.local.json.
//     Called by the frontend when a project is opened / the toggle changes.
//   POST /api/project-activity/:token
//     Activity hook callback for those sessions — Claude's settings.local.json
//     hooks, a user-opened Codex tab's per-launch overrides, the project-root
//     Pi extension: SessionStart/SessionEnd, UserPromptSubmit/Stop,
//     Pre/PostToolUse and SubagentStart/SubagentStop. Keyed by the body's
//     session_id, it drives a node (colored by harness) + focus beams like the
//     Lattice-spawned non-worktree sessions (reuses agentSessions +
//     agentActivity); presence follows turns (projectClaude/lifecycle.ts).

import { promises as fs } from 'node:fs';
import { Router } from 'express';
import { canonicalProjectPath } from '../projectPath.js';
import { applyProjectActivityHook } from '../projectClaude/activity.js';
import { reconcileProjectInstrumentation } from '../projectClaude/reconcile.js';
import { endProjectSession } from '../projectClaude/lifecycle.js';
import { subscribeTerminalRegistry } from '../terminalRegistry/store.js';
import { readProjectParam } from './projectParam.js';

export { applyProjectActivityEvent } from '../projectClaude/lifecycle.js';

// One process-wide subscription, however many times the router is built.
let unsubscribeTabEnds: (() => void) | null = null;

export function buildProjectClaudeRouter(backendOrigin: string): Router {
  const r = Router();

  // A terminal that exits or is closed takes its agent's node with it. Without
  // this a tab killed mid-turn (no Stop, no SessionEnd) kept a node on the
  // graph until the 5-minute idle TTL. No-op for a tab whose conversation
  // never reached the project route.
  if (!unsubscribeTabEnds) {
    unsubscribeTabEnds = subscribeTerminalRegistry((event) => {
      if (event.type === 'ended' && event.agentSessionId) endProjectSession(event.agentSessionId);
    });
  }

  // Writes `<project>/.claude/settings.local.json`, so a relative project is
  // refused before it can resolve under the backend's cwd.
  r.post('/api/project-instrumentation', async (req, res) => {
    const project = readProjectParam(req, res);
    if (project === null) return;
    // The reconcile mkdirs `<project>/.claude/` and writes a `~/.claude.json`
    // entry for it, so a mistyped (or since-deleted) absolute project used to
    // be CREATED on disk as a phantom folder. Refuse anything that isn't an
    // existing directory.
    const root = canonicalProjectPath(project);
    const isDir = await fs.stat(root).then((st) => st.isDirectory(), () => false);
    if (!isDir) {
      return res.status(400).json({ error: `project is not an existing directory: ${JSON.stringify(root)}` });
    }
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
