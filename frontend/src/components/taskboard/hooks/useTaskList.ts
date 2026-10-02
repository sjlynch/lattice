import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchTasks,
  subscribeTasks,
  type Task,
  type TaskSpawnedEvent,
} from '../../../api';

// Cheap per-task signature: every backend mutation bumps `updatedAt` (via
// `stampTimestamps`) and a reorder rewrites `status`/`sortOrder`, so a task
// whose signature is unchanged is byte-identical to the last snapshot for
// everything the board renders. `conflict`/`runQueued` are listed explicitly
// as belt-and-suspenders for the card-visible flags.
function taskSig(t: Task): string {
  return `${t.updatedAt ?? 0}|${t.status}|${t.conflict ? 1 : 0}|${
    t.runQueued ? 1 : 0
  }|${t.sortOrder ?? 0}`;
}

// Structural share: reuse the previous Task object for any id whose signature
// is unchanged, so referentially-stable cards (React.memo on the task object)
// can skip re-render even though the whole list snapshot arrives each frame.
// If every position resolves to the exact object already at that index in
// `prev`, hand back `prev` itself so the array identity is stable too (lets
// the lane grouping/sort memos skip as well, not just the cards).
function structurallyShareTasks(prev: Task[], next: Task[]): Task[] {
  if (prev.length === 0) return next;
  const prevById = new Map(prev.map((t) => [t.id, t]));
  let identical = next.length === prev.length;
  const merged = next.map((t, i) => {
    const old = prevById.get(t.id);
    const reused = old && taskSig(old) === taskSig(t) ? old : t;
    if (reused !== prev[i]) identical = false;
    return reused;
  });
  return identical ? prev : merged;
}

// Owns the per-folder task list: initial fetch, live WS subscription, and
// the in-flight error toast. `showError` is also exposed so action handlers
// in the launcher (run/merge/delete/etc.) can route their failures through
// the same toast slot — keeps the toast a single-source-of-truth.
//
// `onTaskSpawned` (optional) is invoked when a queued task's pty spawns, so
// the launcher can lazy-mount that task's terminal. It must be referentially
// stable (the launcher wraps it in useCallback) — it is an effect dependency.
export function useTaskList(
  activeFolder: string,
  onTaskSpawned?: (event: TaskSpawnedEvent) => void,
) {
  const [taskState, setTaskState] = useState<{
    project: string;
    tasks: Task[];
  }>({ project: '', tasks: [] });
  const [error, setError] = useState<string | null>(null);
  // Hold the auto-dismiss timer so we can clear it on unmount / before
  // re-scheduling instead of leaking a 5 s timer per error (mirrors the
  // copy-timer pattern in shared/ErrorToast.tsx).
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(
      () => setError((cur) => (cur === msg ? null : cur)),
      5000,
    );
  }, []);

  useEffect(
    () => () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    },
    [],
  );

  // Initial load + WS subscription per active folder.
  useEffect(() => {
    if (!activeFolder) {
      setTaskState((prev) =>
        prev.project === '' && prev.tasks.length === 0
          ? prev
          : { project: '', tasks: [] },
      );
      return;
    }
    let cancelled = false;
    let receivedLiveState = false;
    fetchTasks(activeFolder)
      .then((ts) => {
        if (!cancelled && !receivedLiveState) {
          setTaskState((prev) => ({
            project: activeFolder,
            tasks: structurallyShareTasks(
              prev.project === activeFolder ? prev.tasks : [],
              ts,
            ),
          }));
        }
      })
      .catch((err) => console.error('fetchTasks', err));
    const unsub = subscribeTasks(
      activeFolder,
      (ts, { partial }) => {
        // A partial update is the in-progress-only replay a late joiner gets
        // from the shared channel — not a board. The fetch above loads the
        // whole board, so it must neither replace the list nor suppress that
        // fetch as if live state had arrived.
        if (!cancelled && !partial) {
          // A newer board snapshot wins over the initial HTTP request even
          // when that request finishes last during backend recovery.
          receivedLiveState = true;
          setTaskState((prev) => ({
            project: activeFolder,
            tasks: structurallyShareTasks(
              prev.project === activeFolder ? prev.tasks : [],
              ts,
            ),
          }));
        }
      },
      (event) => {
        if (!cancelled) onTaskSpawned?.(event);
      },
      undefined,
      undefined,
      // A deferred run/resume failed (worktree setup threw, terminal-server
      // wedged, …). The HTTP /run|/resume already returned {accepted:true}, so
      // this WS event is the only way the user learns the run never started —
      // surface it on the shared toast.
      (event) => {
        if (cancelled) return;
        const verb = event.kind === 'resume' ? 'resume' : 'start';
        showError(
          `Failed to ${verb} "${event.title || 'task'}": ${event.reason}`,
        );
      },
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder, onTaskSpawned, showError]);

  // During a project switch, render an empty/actionless list until the new
  // project's fetch or WS hello has authoritatively populated this state. That
  // prevents task IDs from project A being visible under project B's header for
  // even one render while the new request is still in flight.
  const tasks = taskState.project === activeFolder ? taskState.tasks : [];

  return { tasks, error, setError, showError };
}
