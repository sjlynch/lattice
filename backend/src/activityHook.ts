// Route-neutral decode of a Claude activity hook body into a graph event.
//
// Three routes receive the same PreToolUse/PostToolUse/SubagentStart/
// SubagentStop hook payload and run identical control flow over it:
//   - tasks/activity.ts     (worktree task agents)
//   - agentActivity.ts      (non-worktree Lattice sessions)
//   - projectClaude.ts      (any project-instrumented Claude session)
// Only their identity (task vs agent/session) and file-mapping differ. This
// captures the shared, non-obvious part — the SubagentStart/Stop satellite
// branch and the phase/tool/subagent-attribution extraction — in one place so
// the three stay in lockstep. Each route decodes its own identity, passes its
// own `mapFile`, then renders the result onto its own notify payload.

import {
  type ClaudeHookPhase,
  fileFromHookBody,
  hookEventName,
  phaseFromHookBody,
  subagentIdFromHookBody,
  subagentTypeFromHookBody,
  toolFromHookBody,
} from './claudeHookBody.js';

// What an activity hook means for the graph, independent of which session it
// came from:
//   - 'lifecycle' — a SubagentStart/Stop: a satellite node appears/disappears
//     on the session's Claude node. Names no file. Only emitted when the hook
//     carries a `subagentId` (otherwise there's nothing to attribute it to).
//   - 'tool'      — a PreToolUse/PostToolUse on a mappable file: a focus beam
//     (on the satellite when `subagentId` is set, else the main node).
// `decodeActivityHook` returns null for anything that should be dropped (a
// lifecycle event with no subagent, or a tool use with no/unmappable file) —
// the routes ack those with no graph effect.
export type ActivityHookResult =
  | {
      kind: 'lifecycle';
      lifecycle: 'spawn' | 'stop';
      subagentId: string;
      subagentType: string | undefined;
    }
  | {
      kind: 'tool';
      file: string;
      phase: ClaudeHookPhase;
      tool: string;
      subagentId: string | undefined;
      subagentType: string | undefined;
    };

// Decode a hook body into an `ActivityHookResult`, or null to drop. `mapFile`
// turns the raw hook path into the project-absolute path the graph expects (or
// null to drop) — worktree-relative for the task route, cwd/absolute for the
// non-worktree routes — and is the only behaviour that varies between callers.
export function decodeActivityHook(
  body: unknown,
  mapFile: (rawFile: string) => string | null,
): ActivityHookResult | null {
  const event = hookEventName(body);
  const subagentId = subagentIdFromHookBody(body);
  const subagentType = subagentTypeFromHookBody(body) ?? undefined;

  // Subagent lifecycle → a satellite appears/disappears around the session's
  // Claude node. No file is named on these events.
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    if (!subagentId) return null;
    return {
      kind: 'lifecycle',
      lifecycle: event === 'SubagentStart' ? 'spawn' : 'stop',
      subagentId,
      subagentType,
    };
  }

  // Tool use → focus beam to the mapped file. A subagent's own tool-use carries
  // `subagentId`, which routes the beam to that satellite instead of the node.
  const rawFile = fileFromHookBody(body);
  if (!rawFile) return null;
  const file = mapFile(rawFile);
  if (!file) return null;
  return {
    kind: 'tool',
    file,
    phase: phaseFromHookBody(body),
    tool: toolFromHookBody(body),
    subagentId: subagentId ?? undefined,
    subagentType,
  };
}
