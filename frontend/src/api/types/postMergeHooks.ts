// Post-merge hook run + lifecycle events — the backend's own types
// (backend/src/postMergeHooks/types.ts, re-exported through
// backend/src/shared/wireTypes.ts). Only the WS envelope and the
// `GET /api/post-merge-hooks/active` snapshot are declared here.
import type {
  PostMergeHookEvent as BackendPostMergeHookEvent,
  PostMergeHookRun,
} from '../../../../backend/src/shared/wireTypes';

export type {
  PostMergeHookRun,
  PostMergeHookStatus,
} from '../../../../backend/src/shared/wireTypes';

// `/ws/post-merge-hooks` also sends `idle` on connect when the project has no
// hook run (ws/endpoints/postMergeHooks.ts).
export type PostMergeHookEvent = BackendPostMergeHookEvent | { type: 'idle' };

export type PostMergeHookSnapshot = {
  active: PostMergeHookRun | null;
  recent: PostMergeHookRun | null;
};
