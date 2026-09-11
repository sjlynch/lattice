import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { TaskCacheManager } from '../taskCache/manager.js';
import { ProjectsIndex } from '../taskCache/projectsIndex.js';
import { TaskMigrations } from '../taskCache/migrations.js';
import { canonicalProjectPath } from '../projectPath.js';
import type { Task } from '../taskCache/types.js';

// BUG 2 regression: updateTaskCrashSafe used to commit the ENTIRE project list
// derived from a PRE-AWAIT snapshot. It read the cached array, computed the
// updated list, then `await this.writeStateNow(...)` (an event-loop yield), and
// only AFTER the disk write did cancelPendingPersist + setCached. Any sibling
// mutation landing during the write window (a Run-All run-attempt bump, a
// Stop-hook /complete flip on a DIFFERENT task, a createTask) was silently
// reverted in cache AND on disk, and its scheduled debounce persist cancelled.
//
// The fix: a per-project async write lock shared by ALL writers (in the
// ProjectStateManager base), plus a re-read of the LIVE cache after the disk
// write so only the single task's delta is re-applied — never a stale full-list
// snapshot. These tests drive the real TaskCacheManager methods with the disk
// write deliberately slowed to open the interleave window the bug needed.

// A TaskCacheManager whose disk write is a controllable in-memory no-op (with an
// optional delay to widen the event-loop yield), so the tests never touch the
// real ~/.lattice files and can force the exact interleave.
class TestTaskCache extends TaskCacheManager {
  public writeDelayMs = 0;
  public diskWrites: Task[][] = [];
  public beforeWrite?: (state: Task[]) => Promise<void>;

  protected async writeStateNow(_projectPath: string, state: Task[]): Promise<void> {
    await this.beforeWrite?.(state);
    if (this.writeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.writeDelayMs));
    }
    this.diskWrites.push(state.map((t) => ({ ...t })));
  }

  // Seed a project as already-loaded so the by-id resolve / ensureProjectLoaded
  // paths never reach the (faked, no-op) index/migrations or real disk.
  seed(project: string, tasks: Task[]): void {
    const key = canonicalProjectPath(project);
    this.setCached(key, tasks);
    this.loaded.set(key, true);
  }

  peek(project: string): Task[] {
    return [...(this.getCached(project) ?? [])];
  }

  cancelPersist(project: string): void {
    this.cancelPendingPersist(project);
  }

  hasPendingPersist(project: string): boolean {
    return this.persistTimers.has(canonicalProjectPath(project));
  }
}

// No-op index/migrations so createTask's ensureProjectLoaded never reads or
// writes the real ~/.lattice/projects.json. `has` returns true so it never
// tries to add+persist the fake project.
function fakeIndex(): ProjectsIndex {
  return {
    loadKnownProjects: async () => {},
    has: () => true,
    add: () => {},
    remove: () => false,
    persistKnownProjects: async () => {},
    values: () => [][Symbol.iterator](),
  } as unknown as ProjectsIndex;
}

function fakeMigrations(): TaskMigrations {
  return {
    runLegacyOnce: async () => {},
    runFirstTouch: async () => {},
  } as unknown as TaskMigrations;
}

function newStore(): TestTaskCache {
  return new TestTaskCache({ projectsIndex: fakeIndex(), migrations: fakeMigrations() });
}

function mkTask(id: string, project: string, extra: Partial<Task> = {}): Task {
  return { id, projectPath: project, title: id, status: 'open', createdAt: 1, ...extra };
}

test('two concurrent updateTaskCrashSafe for different ids in one project both persist', async () => {
  const store = newStore();
  const project = 'C:/crashsafe-concurrent';
  store.seed(project, [mkTask('a', project), mkTask('b', project)]);
  // Both reads happen before either disk write resolves — the exact Run-All
  // shape where N run-attempt bumps read the same snapshot.
  store.writeDelayMs = 25;

  const [ra, rb] = await Promise.all([
    store.updateTaskCrashSafe('a', { runFailureCount: 1 }),
    store.updateTaskCrashSafe('b', { runFailureCount: 1 }),
  ]);
  assert.ok(ra, 'update a returned a task');
  assert.ok(rb, 'update b returned a task');

  const tasks = store.peek(project);
  assert.equal(tasks.find((t) => t.id === 'a')?.runFailureCount, 1, "a's bump survives");
  assert.equal(tasks.find((t) => t.id === 'b')?.runFailureCount, 1, "b's bump survives");
});

test('updateTaskCrashSafe does not revert a concurrent updateTask on a sibling task', async () => {
  const store = newStore();
  const project = 'C:/crashsafe-vs-update';
  store.seed(project, [
    mkTask('crash', project, { status: 'ready_to_merge' }),
    mkTask('flip', project, { status: 'in_progress' }),
  ]);
  store.writeDelayMs = 30;

  // Start the crash-safe update, then fire a Stop-hook-style flip on a DIFFERENT
  // task while the crash-safe disk write is still in flight.
  const crashP = store.updateTaskCrashSafe('crash', { status: 'qa' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const flipP = store.updateTask('flip', { status: 'ready_to_merge' });
  const [crashed, flipped] = await Promise.all([crashP, flipP]);

  assert.equal(crashed?.status, 'qa');
  assert.equal(flipped?.status, 'ready_to_merge');

  const tasks = store.peek(project);
  assert.equal(tasks.find((t) => t.id === 'crash')?.status, 'qa');
  assert.equal(
    tasks.find((t) => t.id === 'flip')?.status,
    'ready_to_merge',
    'the concurrent flip must not be reverted to in_progress',
  );
  // The lock (not just the post-write re-read) is doing its job: because the
  // flip ran AFTER the crash-safe update released the lock, the crash-safe
  // update's cancelPendingPersist could not cancel the flip's scheduled debounce
  // persist — so the flip is guaranteed to reach disk, not just the cache. The
  // old (unlocked) path cancelled it, stranding flip at in_progress on disk.
  assert.ok(
    store.hasPendingPersist(project),
    "the flip's scheduled persist must survive the crash-safe write",
  );

  store.cancelPersist(project);
});

test('updateTaskCrashSafe does not drop a concurrent createTask', async () => {
  const store = newStore();
  const project = 'C:/crashsafe-vs-create';
  store.seed(project, [mkTask('existing', project)]);
  store.writeDelayMs = 30;

  const crashP = store.updateTaskCrashSafe('existing', { runFailureCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const created = await store.createTask(project, 'New task');
  const crashed = await crashP;

  assert.ok(crashed, 'crash-safe update returned');
  const tasks = store.peek(project);
  assert.equal(tasks.length, 2, 'both the existing and the newly-created task remain');
  assert.ok(
    tasks.some((t) => t.id === created.id),
    'the concurrent createTask must survive the crash-safe write',
  );
  assert.equal(
    tasks.find((t) => t.id === 'existing')?.runFailureCount,
    1,
    'the crash-safe bump must survive too',
  );

  store.cancelPersist(project);
});

test('deleting the final task removes a disposable temp project from the live index', async () => {
  const project = canonicalProjectPath(
    path.join(os.tmpdir(), 'lattice-delete-final-task-cleanup'),
  );
  const removed: string[] = [];
  let persistCount = 0;
  const index = {
    loadKnownProjects: async () => {},
    has: () => true,
    add: () => {},
    remove: (candidate: string) => {
      removed.push(candidate);
      return true;
    },
    persistKnownProjects: async () => {
      persistCount += 1;
    },
    values: () => [][Symbol.iterator](),
  } as unknown as ProjectsIndex;
  const store = new TestTaskCache({ projectsIndex: index, migrations: fakeMigrations() });
  store.seed(project, [mkTask('scratch-task', project)]);

  assert.equal(await store.deleteTask('scratch-task'), true);
  assert.deepEqual(store.peek(project), []);
  assert.deepEqual(removed, [project]);
  assert.equal(persistCount, 1);

  store.cancelPersist(project);
});

test('an in-flight debounce cannot overwrite a later crash-safe merge transition', async () => {
  const store = newStore();
  const project = 'C:/debounce-vs-merge';
  store.seed(project, [mkTask('merge', project, { status: 'ready_to_merge' })]);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  store.beforeWrite = async () => {
    if (!first) return;
    first = false;
    enter();
    await held;
  };

  await store.updateTask('merge', { title: 'Debounce pending' });
  await entered; // The timer fired and its old ready_to_merge snapshot is writing.
  const merged = store.updateTaskCrashSafe('merge', { status: 'qa' });
  // Let an incorrectly unlocked crash-safe writer finish before releasing the
  // old debounce; this deterministically reproduces the stale final disk write.
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await merged;
  await store.flushPersist(project);

  assert.deepEqual(
    store.diskWrites.map((tasks) => tasks[0].status),
    ['ready_to_merge', 'qa', 'qa'],
    'old debounce must finish before the crash-safe transition can commit',
  );
});

test('flushPersist waits for a crash-safe write and reads the cache after its lock', async () => {
  const store = newStore();
  const project = 'C:/flush-vs-merge';
  store.seed(project, [mkTask('merge', project, { status: 'ready_to_merge' })]);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let first = true;
  store.beforeWrite = async () => {
    if (!first) return;
    first = false;
    enter();
    await held;
  };

  const merged = store.updateTaskCrashSafe('merge', { status: 'qa' });
  await entered;
  const flushed = store.flushPersist(project);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await Promise.all([merged, flushed]);

  assert.deepEqual(store.diskWrites.map((tasks) => tasks[0].status), ['qa', 'qa']);
});
