// Public facade for the merge-run conflict-resolver spawn subsystem. The
// implementation is split by concern under `resolverSpawn/` so the
// terminal-session spawn mechanics stay separate from the resync-outcome
// policy that drives them; existing `./resolverSpawn.js` import paths keep
// working unchanged.
//   - `park.ts` — parkOnConflictResolver (drops the per-task merge lock before
//     waiting on the conflict waiter — see the deadlock note there)
//   - `spawn.ts` — terminal-session spawn/notify/record mechanics
//     (queuedCreateSession, conflict notification, spawnAndRecord/recordAndSpawn,
//     respawnResolverForFlaggedConflict)
//   - `handleOutcome.ts` — handleResyncOutcome: the higher-level policy deciding
//     whether to finalize, park on a resolver, cancel after a stash conflict, or
//     record an error
export { parkOnConflictResolver } from './resolverSpawn/park.js';
export {
  spawnAndRecord,
  recordAndSpawn,
  respawnResolverForFlaggedConflict,
  type ResolverSpawnResult,
} from './resolverSpawn/spawn.js';
export { handleResyncOutcome } from './resolverSpawn/handleOutcome.js';
