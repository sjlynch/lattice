import { useCallback, useRef } from 'react';
import { type TaskSpawnedEvent } from '../../../api';
import type { AddTerminalSpec } from '../../../terminal/terminalTypes';
import { shortLabel } from '../lanes';

type AddTerminal = (spec: AddTerminalSpec, focus?: boolean) => string;
type CloseTerminalsForTask = (taskId: string, keep?: { id?: string; serverId?: string }) => void;

// Builds the `/ws/tasks` `task-spawned` handler. A queued task's run has no pty
// at request time; when the spawn queue admits it the backend emits
// `task-spawned`, and this mounts the task's terminal (lazy — the pane renders
// on activation). Every tab watching the project mounts it.
//
// Before mounting, it closes any terminal already tagged with this taskId so a
// single task never owns two tabs. This is the Resume case: resuming an
// in_progress task re-spawns the harness in the SAME worktree with a fresh
// serverId (backend `resumeTask.ts`), emitting a second `task-spawned`. The
// prior tab is stale (the earlier session ended without committing — exactly
// why Resume exists) and `useTaskTerminalCleanup` only closes terminals for
// ready_to_merge/qa/done/deleted, never in_progress, so it lingers. Closing it
// first (the batched `closeTerminalsForTask` DELETEs the dead pty and drops the
// tab) makes the newly-delivered serverId authoritative — one terminal per task
// per tab, the invariant the rest of the terminal code preserves.
//
// The handler also pings the "Resume all" bulk strip, which has no task-state
// signal of its own. That notifier is produced by `useBulkRunStrips`, which runs
// *after* the task list (it needs `tasks`, which needs this handler) — so it's
// bridged in through a ref via `setBulkSpawnNotifier`, breaking the declaration
// cycle that would otherwise force this wiring to live inline in the launcher.
export function useTaskSpawnHandler(
  addTerminal: AddTerminal,
  closeTerminalsForTask: CloseTerminalsForTask,
) {
  const noteBulkSpawnedRef = useRef<((taskId: string) => void) | null>(null);

  const handleTaskSpawned = useCallback(
    (event: TaskSpawnedEvent) => {
      noteBulkSpawnedRef.current?.(event.taskId);
      // Replace, don't duplicate: drop any stale tab for this task (e.g. the
      // ended pre-resume session) before mounting the fresh pty — but never the
      // fresh pty's own tab. The registry's `upsert` for the new record usually
      // lands BEFORE this event and has already mounted it (tagged with this
      // taskId), so a plain per-task close DELETEd the agent that was just
      // spawned: every queued run and every Resume killed itself ~30 ms after
      // starting whenever the board was open (2026-09-23).
      closeTerminalsForTask(event.taskId, { id: event.terminalId, serverId: event.serverId });
      addTerminal(
        {
          id: event.terminalId,
          label: shortLabel(event.title),
          cwd: event.worktreePath,
          initialCommand: event.command,
          taskId: event.taskId,
          projectPath: event.projectPath,
          serverId: event.serverId,
        },
        false,
      );
    },
    [addTerminal, closeTerminalsForTask],
  );

  // Stable setter so the launcher (or a downstream hook) can wire in the bulk
  // notifier once `useBulkRunStrips` has produced it.
  const setBulkSpawnNotifier = useCallback(
    (notify: (taskId: string) => void) => {
      noteBulkSpawnedRef.current = notify;
    },
    [],
  );

  return { handleTaskSpawned, setBulkSpawnNotifier };
}
