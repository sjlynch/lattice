import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileEditFields,
  computeSavePayload,
} from '../components/taskboard/hooks/useTaskDetailEdit.ts';

type TaskLike = { id: string; title: string; description?: string };

// A faithful stand-in for the hook's state machine: local fields + the
// baseline, reconciled on every keystroke (the effect re-runs on editTitle/
// editDesc changes) and on every incoming task update — exactly the two
// triggers in useTaskDetailEdit's effect. Lets us drive the same-ID-update
// scenario without a DOM/React renderer.
function makeEditor(initial: TaskLike) {
  let task: TaskLike = { ...initial };
  let local = { title: task.title, description: task.description ?? '' };
  let baseline = {
    id: task.id,
    title: task.title,
    description: task.description ?? '',
  };
  function applyReconcile() {
    const r = reconcileEditFields(task, local, baseline);
    local = r.fields;
    baseline = r.baseline;
  }
  return {
    get title() {
      return local.title;
    },
    get description() {
      return local.description;
    },
    type(field: 'title' | 'description', value: string) {
      local = { ...local, [field]: value };
      applyReconcile(); // the effect re-runs on every keystroke
    },
    receive(next: TaskLike) {
      task = { ...next };
      applyReconcile();
    },
    save() {
      return computeSavePayload(task, local.title, local.description);
    },
  };
}

test('a same-ID description update arriving before any user input syncs in — Save does not send the old description', () => {
  const ed = makeEditor({ id: 't1', title: 'T', description: 'old' });

  // No user input. A WebSocket task-list update changes the description on the
  // SAME task (e.g. an agent appended a resolution summary).
  ed.receive({ id: 't1', title: 'T', description: 'new' });

  assert.equal(
    ed.description,
    'new',
    'the untouched field adopts the server update instead of shadowing it',
  );
  // The crux: Save carries nothing stale — definitely not the old description.
  assert.equal(ed.save(), null, 'nothing is dirty, so Save sends nothing');
});

test('regression: without the sync, Save clobbers the server update with the stale local description', () => {
  // Pre-fix behavior reproduced directly: the local field stayed 'old' while
  // the task moved to 'new', so the (unchanged-by-the-user) field was sent and
  // overwrote the newer server value.
  const payload = computeSavePayload({ title: 'T', description: 'new' }, 'T', 'old');
  assert.deepEqual(
    payload,
    { description: 'old' },
    'documents the bug the sync prevents',
  );
});

test('a user edit is preserved across a same-ID update and is what Save sends', () => {
  const ed = makeEditor({ id: 't1', title: 'T', description: 'old' });

  ed.type('description', 'my draft');
  // A concurrent server change to the same field arrives while the user is
  // mid-edit. The draft wins.
  ed.receive({ id: 't1', title: 'T', description: 'server changed' });

  assert.equal(ed.description, 'my draft', 'the in-progress edit is preserved');
  assert.deepEqual(
    ed.save(),
    { description: 'my draft' },
    'Save sends the user edit, not the server value',
  );
});

test('an untouched title syncs while the description is being edited — no stale-field clobber on Save', () => {
  const ed = makeEditor({ id: 't1', title: 'T', description: 'old' });

  ed.type('description', 'draft');
  // The server changes the title (a field the user has NOT touched).
  ed.receive({ id: 't1', title: 'T2', description: 'old' });

  assert.equal(ed.title, 'T2', 'the untouched title adopts the server change');
  assert.equal(ed.description, 'draft');
  // Save carries only the field the user actually changed — the now-stale old
  // title is never written back.
  assert.deepEqual(ed.save(), { description: 'draft' });
});

test('switching to a different task id discards the draft and seeds from the new task', () => {
  const ed = makeEditor({ id: 't1', title: 'T', description: 'old' });

  ed.type('description', 'draft for t1');
  ed.receive({ id: 't2', title: 'Other', description: 'other desc' });

  assert.equal(ed.title, 'Other');
  assert.equal(ed.description, 'other desc');
  assert.equal(ed.save(), null, 'a freshly-loaded task is not dirty');
});

test('reverting a draft back to the server value clears the dirty flag', () => {
  const ed = makeEditor({ id: 't1', title: 'T', description: 'old' });
  ed.type('description', 'old changed');
  assert.deepEqual(ed.save(), { description: 'old changed' });
  // User deletes their edit back to the original.
  ed.type('description', 'old');
  assert.equal(ed.save(), null, 'matching the server again is not dirty');
});
