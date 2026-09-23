import type { LockBody } from './types.js';
import { isCurrentProcessHolder } from './liveness.js';

// The label prefix of the workflow Run tests step's hold (see
// workflowRuns/testStep/). Named here so the refusal message can say what is
// actually going on instead of "another process".
export const RUN_TESTS_LOCK_LABEL_PREFIX = 'workflow-test:';

export function describeProjectRunLockHolder(holder: LockBody): string {
  const since = new Date(holder.startedAt).toISOString();
  if (isCurrentProcessHolder(holder)) {
    if (holder.label.startsWith(RUN_TESTS_LOCK_LABEL_PREFIX)) {
      const runId = holder.label.slice(RUN_TESTS_LOCK_LABEL_PREFIX.length);
      return (
        `A workflow Run tests step (run ${runId}) is running the project's tests and ` +
        `committing fixes on its main checkout (since ${since}). Merging waits until that ` +
        `step finishes — try again then, or stop the workflow run.`
      );
    }
    return `Project run lock held by this Lattice backend (label=${holder.label}, started ${since}).`;
  }
  return (
    `Project run lock held by another process ` +
    `(pid=${holder.pid} on ${holder.hostname}, started ${since}, label=${holder.label}).`
  );
}

export class ProjectRunLockedError extends Error {
  readonly holder: LockBody;

  constructor(holder: LockBody) {
    super(describeProjectRunLockHolder(holder));
    this.name = 'ProjectRunLockedError';
    this.holder = holder;
  }
}
