// Spawn-queue wrappers for task run / resume.
//
// Compatibility barrel. The HTTP /run and /resume routes (and the delete /
// cancel-queued-run handlers, boot recovery, and the unit tests) import the
// queued-spawn surface from here. The implementation was split by concern into
// focused modules; this re-exports them under the original import path so those
// callers keep importing from `./queuedSpawn.js` unchanged.
//
//   - queuedSpawnAdmission.ts : queue identity keys, the persisted run-queue
//                               admission policy (+ its cleared inverse), and
//                               the injectable failure-path I/O deps.
//   - queuedSpawnFailure.ts   : the shared thunk body — crash-safe attempt
//                               counting, CAP retry undo, and terminal
//                               failure reporting (`task-spawn-failed`).
//   - queuedSpawnEnqueue.ts   : the run/resume enqueue wrappers + cancellation.

export {
  taskRunDedupeKey,
  taskResumeDedupeKey,
  type EnqueueTaskResult,
  type SpawnFailureDeps,
} from './queuedSpawnAdmission.js';
export { reportSpawnFailure, runSpawnThunk } from './queuedSpawnFailure.js';
export {
  enqueueTaskRun,
  enqueueTaskResume,
  cancelQueuedTaskSpawns,
  dequeueTaskRun,
} from './queuedSpawnEnqueue.js';
