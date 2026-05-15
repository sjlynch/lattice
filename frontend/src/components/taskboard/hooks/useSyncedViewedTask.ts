import { useEffect, useState } from 'react';
import type { Task } from '../../../api';

// Keeps the detail overlay's task object synchronized with live task-list
// updates. If the task disappears, the overlay closes; if a fresh object for
// the same task arrives, callers receive that updated task.
export function useSyncedViewedTask(tasks: Task[]) {
  const [viewing, setViewing] = useState<Task | null>(null);

  useEffect(() => {
    if (!viewing) return;
    const fresh = tasks.find((task) => task.id === viewing.id);
    if (!fresh) {
      setViewing(null);
      return;
    }
    if (fresh !== viewing) setViewing(fresh);
  }, [tasks, viewing]);

  return [viewing, setViewing] as const;
}
