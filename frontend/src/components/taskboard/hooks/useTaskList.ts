import { useCallback, useEffect, useState } from 'react';
import { fetchTasks, subscribeTasks, type Task } from '../../../api';

// Owns the per-folder task list: initial fetch, live WS subscription, and
// the in-flight error toast. `showError` is also exposed so action handlers
// in the launcher (run/merge/delete/etc.) can route their failures through
// the same toast slot — keeps the toast a single-source-of-truth.
export function useTaskList(activeFolder: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);

  const showError = useCallback((msg: string) => {
    setError(msg);
    setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 5000);
  }, []);

  // Initial load + WS subscription per active folder.
  useEffect(() => {
    if (!activeFolder) {
      setTasks([]);
      return;
    }
    let cancelled = false;
    fetchTasks(activeFolder)
      .then((ts) => {
        if (!cancelled) setTasks(ts);
      })
      .catch((err) => console.error('fetchTasks', err));
    const unsub = subscribeTasks(activeFolder, (ts) => {
      if (!cancelled) setTasks(ts);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [activeFolder]);

  return { tasks, error, setError, showError };
}
