// Compatibility barrel. The CRUD handlers were split by concern into
// focused modules; this re-exports them under the original import path so
// `crud.ts` (the router) and the project-scoping test keep importing from
// `./crudHandlers.js` unchanged.
//
//   - crudList.ts       : partitionByProject + list / summary / projects / get
//   - crudCreate.ts     : create / batch-create (JSON + markdown parsing)
//   - crudUpdate.ts     : patch / bulk-update / upsert / append-summary
//                         (thin handlers; helpers in crudUpdateBody /
//                         crudUpdateValidation / crudUpdateUpsert)
//   - crudTransition.ts : bulk status transition + lane reorder
//   - crudDelete.ts     : delete + cancel-queued-run (spawn-queue cleanup)

export {
  partitionByProject,
  handleTaskList,
  handleTaskSummary,
  handleProjectsList,
  handleTaskGet,
} from './crudList.js';
export {
  handleTaskCreate,
  handleTaskBatchCreate,
} from './crudCreate.js';
export {
  handleTaskUpdate,
  handleTaskAppendSummary,
  appendSummaryText,
  handleTaskBulkUpdate,
  handleTaskUpsert,
  classifyUpsertTarget,
} from './crudUpdate.js';
export {
  handleTaskTransition,
  handleTaskReorder,
} from './crudTransition.js';
export {
  handleTaskCancelQueuedRun,
  handleTaskDelete,
} from './crudDelete.js';
