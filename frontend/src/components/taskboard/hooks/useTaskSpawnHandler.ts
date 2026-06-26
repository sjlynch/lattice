import { useCallback, useRef } from 'react';
import { type TaskSpawnedEvent } from '../../../api';
import { type TerminalSpec } from '../../../TerminalsContext';
import { shortLabel } from '../lanes';

type AddTerminal = (spec: Omit<TerminalSpec, 'id'>, focus?: boolean) => string;

// Builds the `/ws/tasks` `task-spawned` handler. A queued task's run has no pty
// at request time; when the spawn queue admits it the backend emits
// `task-spawned`, and this mounts the task's terminal (lazy — the pane renders
// on activation). Every tab watching the project mounts it.
//
// The handler also pings the "Resume all" bulk strip, which has no task-state
// signal of its own. That notifier is produced by `useBulkRunStrips`, which runs
// *after* the task list (it needs `tasks`, which needs this handler) — so it's
// bridged in through a ref via `setBulkSpawnNotifier`, breaking the declaration
// cycle that would otherwise force this wiring to live inline in the launcher.
export function useTaskSpawnHandler(addTerminal: AddTerminal) {
  const noteBulkSpawnedRef = useRef<((taskId: string) => void) | null>(null);

  const handleTaskSpawned = useCallback(
    (event: TaskSpawnedEvent) => {
      noteBulkSpawnedRef.current?.(event.taskId);
      addTerminal(
        {
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
    [addTerminal],
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
