// The timeline scrubber's `GET /api/git-history` payload — the backend's own
// types (backend/src/gitHistory/types.ts, re-exported through
// backend/src/shared/wireTypes.ts).
export type {
  GitCommit,
  GitCommitChange,
  GitFileStatus,
  GitHistoryResult,
  GitUncommitted,
} from '../../../../backend/src/shared/wireTypes';
