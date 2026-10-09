// Merge-run, push-run and QA-run payloads — the backend's own types
// (backend/src/{mergeRuns,pushRuns,qaRuns}/types.ts, re-exported through
// backend/src/shared/wireTypes.ts). Only the WS envelope and the polled
// statuses are composed here.
import type {
  MergeRunEvent as BackendMergeRunEvent,
  PushRun,
  QaRun,
} from '../../../../backend/src/shared/wireTypes';

export type {
  MergeRun,
  MergeRunErrorEntry,
  MergeRunStatus,
  StartPushRunResult,
  StartQaRunResult,
} from '../../../../backend/src/shared/wireTypes';

// `/ws/merge-runs` also sends `idle` on connect when no run is active
// (ws/endpoints/mergeRuns.ts), so the client can clear stale run state.
export type MergeRunEvent = BackendMergeRunEvent | { type: 'idle' };

// `status` of the polled `GET /api/push-runs/:id` / `GET /api/qa-runs/:id`.
export type PushRunStatus = PushRun['status'];
export type QaRunStatus = QaRun['status'];
