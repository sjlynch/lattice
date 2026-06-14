import { useEffect, useRef, useState } from 'react';
import type { Task } from '../../../api';

export type TaskDetailEditUpdates = { title?: string; description?: string };

export type TaskDetailEdit = {
  editTitle: string;
  setEditTitle: (value: string) => void;
  editDesc: string;
  setEditDesc: (value: string) => void;
  dirty: boolean;
  // Returns the trimmed/changed-field payload, or null when nothing is dirty.
  prepareSave: () => TaskDetailEditUpdates | null;
};

// Encapsulates the detail overlay's editable title/description state, the
// dirty check, and save-payload preparation for a given task. Fields reset
// only when the modal switches to a different task — in-flight edits survive
// WS updates to the same task.
export function useTaskDetailEdit(task: Task): TaskDetailEdit {
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description ?? '');

  const lastTaskIdRef = useRef(task.id);
  useEffect(() => {
    if (lastTaskIdRef.current !== task.id) {
      lastTaskIdRef.current = task.id;
      setEditTitle(task.title);
      setEditDesc(task.description ?? '');
    }
  }, [task.id, task.title, task.description]);

  const trimmedTitle = editTitle.trim();
  const titleChanged = trimmedTitle !== task.title;
  const descChanged = editDesc !== (task.description ?? '');
  const dirty = (titleChanged && trimmedTitle.length > 0) || descChanged;

  function prepareSave(): TaskDetailEditUpdates | null {
    if (!dirty) return null;
    const updates: TaskDetailEditUpdates = {};
    if (titleChanged && trimmedTitle.length > 0) updates.title = trimmedTitle;
    if (descChanged) updates.description = editDesc;
    if (Object.keys(updates).length === 0) return null;
    return updates;
  }

  return {
    editTitle,
    setEditTitle,
    editDesc,
    setEditDesc,
    dirty,
    prepareSave,
  };
}
