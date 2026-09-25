import {
  cwdFromHookBody,
  hookEventName,
  sessionIdFromHookBody,
} from '../claudeHookBody.js';
import { notifyAgentActivity } from '../agentActivity.js';
import { decodeAgentToken } from '../agentActivityTokens.js';
import { buildAgentActivityEvents } from '../routes/agentActivity.js';
import { applyProjectActivityEvent, projectSessionAgentId } from './lifecycle.js';
import { normalizeAgentHarness } from '../harnesses.js';
import { isLatticeManagedCwd } from './managedCwd.js';

export function applyProjectActivityHook(token: string, body: unknown): void {
  const meta = decodeAgentToken(token);
  if (!meta) return;
  const sessionId = sessionIdFromHookBody(body);
  if (!sessionId) return;
  const cwd = cwdFromHookBody(body);
  // Dedup: a worktree/scratch session is already tracked elsewhere.
  if (cwd && isLatticeManagedCwd(cwd)) return;

  const agentId = projectSessionAgentId(sessionId);
  const event = hookEventName(body);

  // Presence follows the agent's turns (see lifecycle.ts). A late hook after
  // SessionEnd never resurrects the node.
  const { emitActivity } = applyProjectActivityEvent({
    event,
    sessionId,
    agentId,
    projectPath: meta.projectPath,
    label: meta.label,
    // The token label names the harness that installed the hook ('claude' for
    // the project's settings.local.json hooks, 'codex' / 'pi' for terminal
    // launches); the graph colors the node by it.
    harness: normalizeAgentHarness(meta.label),
  });
  if (!emitActivity) return;

  // Subagent lifecycle (satellite spawn/stop) or tool-use (focus beam) — the
  // same decode as the other two activity routes, keyed on this session's
  // `claude:<sessionId>` agent id rather than the token's.
  for (const activity of buildAgentActivityEvents(meta, body, { agentId, cwd })) {
    notifyAgentActivity(activity);
  }
}
