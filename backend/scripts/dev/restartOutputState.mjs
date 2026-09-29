import { shouldRestartForDist } from './distSignature.mjs';

// Per-policy output bookkeeping only. The policy decides when a restart is
// admitted and when a deferral is cleared; constructing this state reads nothing.
export function createRestartOutputState({ readNewestDistMtime, readDistContentSignature }) {
  // Output attributed to the running backend (or an accepted legacy restart).
  let distBaseline = null;
  let contentBaseline = null;
  let completedCompileSequence = 0;
  let lastCompletedContent = null;

  function captureDistBaseline() {
    return { mtime: readNewestDistMtime(), content: readDistContentSignature(), compileSequence: completedCompileSequence };
  }

  function resetDistBaseline() {
    distBaseline = readNewestDistMtime();
    contentBaseline = readDistContentSignature();
  }

  // Legacy callers baseline an accepted restart immediately. The policy keeps
  // this separate from the actual-spawn path and clears its deferral first.
  function commitRestartBaseline(newestSeen) {
    distBaseline =
      typeof newestSeen === 'number' ? newestSeen : readNewestDistMtime();
    contentBaseline = readDistContentSignature();
  }

  // A candidate was captured BEFORE spawn. Never re-read output here: another
  // compile may already be writing partial output when the spawn event arrives.
  function commitSpawnBaseline(candidate) {
    distBaseline = candidate.mtime;
    contentBaseline = candidate.content;
  }

  function hasDistChange(newest) {
    return shouldRestartForDist({ newest, baseline: distBaseline });
  }

  function recordCompletedCompile() {
    const current = readDistContentSignature();
    completedCompileSequence++;
    lastCompletedContent = current;
    return current;
  }

  // Null is unknown, never proof that completed output matches the backend.
  // Kept separate from recording so the policy can probe needsBackendStart
  // between the content read and this comparison, in the original order.
  function isUnchangedCompile(current) {
    return current !== null && current === contentBaseline;
  }

  function resetMtimeBaseline() {
    distBaseline = readNewestDistMtime();
  }

  // The policy checks its compile gate after committing the spawn and clearing
  // the deferral, then routes a newer, changed/unknown compile through admission.
  function needsCompileCatchUp(candidate) {
    return candidate.compileSequence < completedCompileSequence &&
      !(lastCompletedContent !== null && lastCompletedContent === contentBaseline);
  }

  return {
    captureDistBaseline,
    resetDistBaseline,
    commitRestartBaseline,
    commitSpawnBaseline,
    hasDistChange,
    recordCompletedCompile,
    isUnchangedCompile,
    resetMtimeBaseline,
    needsCompileCatchUp,
  };
}
