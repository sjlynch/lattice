// Small FIFO independent of PTY capacity: a review is a headless CLI, while
// rejected-task re-runs still use the persisted task spawn queue.
export function createReviewQueue(limit = 4) {
  const jobs = new Map<string, { run: () => Promise<void>; running: boolean; next?: () => Promise<void> }>();
  const pending: string[] = [];
  let active = 0;
  function pump(): void {
    while (active < limit && pending.length) {
      const key = pending.shift()!;
      const job = jobs.get(key)!;
      job.running = true;
      active++;
      void Promise.resolve().then(job.run).catch((error) => console.error('[task-review]', error)).finally(() => {
        active--;
        if (job.next) {
          jobs.set(key, { run: job.next, running: false });
          pending.push(key);
        } else jobs.delete(key);
        pump();
      });
    }
  }
  return {
    get size() { return jobs.size; },
    get active() { return active; },
    enqueue(key: string, job: () => Promise<void>, options: { reschedule?: boolean } = {}): boolean {
      const existing = jobs.get(key);
      if (existing) {
        // Admission of a newer head can land in the tiny gap between a
        // worker's final read and its finally. Preserve that wake-up.
        if (options.reschedule) {
          if (existing.running) existing.next = job;
          else existing.run = job;
        }
        return false;
      }
      jobs.set(key, { run: job, running: false });
      pending.push(key);
      pump();
      return true;
    },
  };
}
