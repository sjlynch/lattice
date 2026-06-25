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

// The server snapshot the editable fields were last seeded/synced from. A field
// counts as "locally edited" iff it differs from this baseline — which is what
// lets a same-task update sync into an untouched field without measuring
// dirtiness against the (already-changed) incoming task.
type EditBaseline = { id: string; title: string; description: string };
type EditFields = { title: string; description: string };

// Reconcile the local fields against an incoming task object. Pure so the
// same-ID-update behavior can be tested without React.
//   - Different task id → switching tasks: reset both fields to the new task,
//     discarding any draft (a draft for task A must never bleed into task B).
//   - Same id, field NOT locally edited → adopt the incoming server value so a
//     same-task WS update lands. Otherwise a stale local field shadows the
//     update and Save writes it back, silently clobbering the change.
//   - Same id, field locally edited → keep the user's draft. The baseline still
//     advances to the incoming value, so a field the user never touched can't
//     clobber a concurrent server change on Save, and reverting the draft to
//     match the server cleanly clears the dirty flag.
// Per-field (not whole-editor): editing the title still lets a description
// update sync, which is the exact stale-field case this guards against.
export function reconcileEditFields(
  task: { id: string; title: string; description?: string },
  local: EditFields,
  baseline: EditBaseline,
): { fields: EditFields; baseline: EditBaseline } {
  const incoming: EditFields = {
    title: task.title,
    description: task.description ?? '',
  };
  if (baseline.id !== task.id) {
    return { fields: incoming, baseline: { id: task.id, ...incoming } };
  }
  const titleEdited = local.title !== baseline.title;
  const descEdited = local.description !== baseline.description;
  return {
    fields: {
      title: titleEdited ? local.title : incoming.title,
      description: descEdited ? local.description : incoming.description,
    },
    baseline: { id: task.id, ...incoming },
  };
}

// The Save payload: only the fields the user actually changed relative to the
// CURRENT server task (a blank title is never sent). Pure so a test can assert
// that, after a same-ID description update has synced in, Save no longer
// carries the old description.
export function computeSavePayload(
  task: { title: string; description?: string },
  editTitle: string,
  editDesc: string,
): TaskDetailEditUpdates | null {
  const trimmedTitle = editTitle.trim();
  const titleChanged = trimmedTitle !== task.title;
  const descChanged = editDesc !== (task.description ?? '');
  const updates: TaskDetailEditUpdates = {};
  if (titleChanged && trimmedTitle.length > 0) updates.title = trimmedTitle;
  if (descChanged) updates.description = editDesc;
  if (Object.keys(updates).length === 0) return null;
  return updates;
}

// Encapsulates the detail overlay's editable title/description state, the
// dirty check, and save-payload preparation for a given task. Fields reset when
// the modal switches to a different task; for a same-task update they sync into
// any field the user hasn't touched (and preserve the ones they have).
export function useTaskDetailEdit(task: Task): TaskDetailEdit {
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDesc, setEditDesc] = useState(task.description ?? '');

  const baselineRef = useRef<EditBaseline>({
    id: task.id,
    title: task.title,
    description: task.description ?? '',
  });

  useEffect(() => {
    const incomingTask = {
      id: task.id,
      title: task.title,
      description: task.description,
    };
    const { fields, baseline } = reconcileEditFields(
      incomingTask,
      { title: editTitle, description: editDesc },
      baselineRef.current,
    );
    baselineRef.current = baseline;
    // Guarded so a no-op reconcile (the common keystroke re-run) doesn't
    // setState and re-loop; once synced, reconcile is a fixed point.
    if (fields.title !== editTitle) setEditTitle(fields.title);
    if (fields.description !== editDesc) setEditDesc(fields.description);
  }, [task.id, task.title, task.description, editTitle, editDesc]);

  const dirty = computeSavePayload(task, editTitle, editDesc) !== null;

  function prepareSave(): TaskDetailEditUpdates | null {
    return computeSavePayload(task, editTitle, editDesc);
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
