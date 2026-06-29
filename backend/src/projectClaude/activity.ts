import {
  cwdFromHookBody,
  hookEventName,
  sessionIdFromHookBody,
} from '../claudeHookBody.js';
import { notifyAgentActivity } from '../agentActivity.js';
import { decodeAgentToken } from '../agentActivityTokens.js';
import { buildAgentActivityEvent } from '../routes/agentActivity.js';
import { applyProjectActivityEvent } from './lifecycle.js';
import { isLatticeManagedCwd } from './managedCwd.js';

export function applyProjectActivityHook(token: string, body: unknown): void {
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
