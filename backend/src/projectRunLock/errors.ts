import type { LockBody } from './types.js';

export class ProjectRunLockedError extends Error {
  readonly holder: LockBody;

  constructor(holder: LockBody) {
    super(
      `Project run lock held by another process ` +
        `(pid=${holder.pid} on ${holder.hostname}, started ` +
        `${new Date(holder.startedAt).toISOString()}, label=${holder.label}).`,
    );
    this.name = 'ProjectRunLockedError';
    this.holder = holder;
  }
}
