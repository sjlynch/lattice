import type { AgentSession, Task } from '../../../api';
import { sessionColor, taskColor } from '../../../taskColors';
import type { PendingActivityBuffer } from '../agentActivityBuffer';
import type { AgentDescriptor, AgentOverlay } from '../agentOverlay';

// Every harness reports activity: Claude through its hooks
// (`.claude/settings.local.json`), Codex through `.codex/hooks.json` (same hook
// events, edits via `apply_patch`, reads via the shell), Pi through the
// `.pi/extensions/lattice-activity.ts` extension — so any in-progress task gets
// a node, whatever its harness.
export function taskDescriptors(tasks: Task[]): AgentDescriptor[] {
  return tasks
    .filter((t) => t.status === 'in_progress')
    .map((t) => ({ taskId: t.id, color: taskColor(t) }));
}

export function sessionDescriptors(sessions: AgentSession[]): AgentDescriptor[] {
  return sessions.map((s) => ({ taskId: s.agentId, color: sessionColor(s) }));
}

// Cheap equality on a descriptor set: `/ws/tasks` re-pushes a full snapshot for
// ANY board change (a status flip on an unrelated task, a title edit), so the
// recomputed array is usually identical to the last one. Guarding the apply on
// an actual change keeps a busy board from running a full `overlay.setAgents`
// reconcile on every WS message. Mirrors `sameSet`/`lastAppliedRef` in
// `useGraphSearch`. Order is stable (both descriptor sources map in input
// order), so an index-wise compare on `taskId` + `color` is sufficient.
export function sameDescriptors(
  a: AgentDescriptor[],
  b: AgentDescriptor[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].taskId !== b[i].taskId || a[i].color !== b[i].color) return false;
  }
  return true;
}

// The fields a `task-activity` / `agent-activity` frame carries that the
// overlay routing cares about — shared shape of TaskActivityEvent and
// AgentActivityEvent so one router handles both (keyed by the parent's id).
export type ActivityLike = {
  file?: string;
  phase: 'start' | 'end';
  subagentId?: string;
  subagentType?: string;
  lifecycle?: 'spawn' | 'stop';
};

type ActivityOverlay = Pick<
  AgentOverlay,
  'hasAgent' | 'addSubagent' | 'removeSubagent' | 'addSubagentActivity' | 'addActivity'
>;

// Route one activity/lifecycle frame to the overlay, keyed by the parent
// agent's id (taskId for task-activity, agentId for agent-activity):
//   - lifecycle 'spawn'/'stop' → a subagent satellite appears/disappears.
//   - a tool-use frame with `subagentId` → a satellite's focus beam.
//   - a plain tool-use frame → the main agent's focus beam.
// The hook drops frames without an overlay and supplies its buffer and timestamp.
export function routeAgentActivity(
  ov: ActivityOverlay,
  pending: Pick<PendingActivityBuffer<ActivityLike>, 'add'>,
  parentId: string,
  event: ActivityLike,
  now: number,
  kick: () => void,
  wakeRefresh: () => void,
): void {
  // No node yet: hold the frame until the presence snapshot that creates
  // it arrives (a different socket — see agentActivityBuffer). Replayed by
  // applyMerged in the hook.
  if (!ov.hasAgent(parentId)) {
    pending.add(parentId, event, now);
    return;
  }
  if (event.lifecycle === 'spawn') {
    // The new satellite eases out from the parent — kick() animates it.
    if (
      event.subagentId &&
      ov.addSubagent(parentId, event.subagentId, event.subagentType, now)
    ) {
      kick();
    }
    return;
  }
  if (event.lifecycle === 'stop') {
    if (event.subagentId && ov.removeSubagent(parentId, event.subagentId)) {
      wakeRefresh();
    }
    return;
  }
  if (!event.file) return;
  const applied = event.subagentId
    ? ov.addSubagentActivity(
        parentId,
        event.subagentId,
        event.subagentType,
        event.file,
        event.phase,
        now,
      )
    : ov.addActivity(parentId, event.file, event.phase, now);
  if (applied) kick();
}

// One beat of the hook's slow satellite-reap timer (the missed-SubagentStop
// safety net). Reaps right here rather than waking the loop for `tick` to do
// it, since the loop can't render while the tab is hidden or the graph is
// 0×0. Then wakes the loop: `kick` for the parent easing back over its own
// files, `wakeRefresh` for the removal itself, as a SubagentStop does above.
export function reapStaleSatellites(
  ov: Pick<AgentOverlay, 'reapSatellites'>,
  now: number,
  kick: () => void,
  wakeRefresh: () => void,
): void {
  if (!ov.reapSatellites(now)) return;
  kick();
  wakeRefresh();
}
