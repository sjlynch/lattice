import { canonicalProjectPath } from '../projectPath.js';
import { watcherScanRevision } from '../health/watcher.js';
import { ScanCancelledError } from './fileMetrics.js';
import { scan } from './scan.js';
import type { ScanResult } from './graphAggregate.js';

type ScanEntry = {
  promise: Promise<ScanResult>;
  controller: AbortController;
  subscribers: number;
  revision: number | undefined;
};

// Share work, never settled results. A disconnected tab releases only its own
// subscription; the underlying scan stops when its final subscriber leaves.
export class ScanCoordinator {
  private active = new Map<string, ScanEntry>();

  constructor(
    private runScan = scan,
    private getRevision = watcherScanRevision,
  ) {}

  request(projectRoot: string, signal?: AbortSignal): Promise<ScanResult> {
    if (signal?.aborted) return Promise.reject(new ScanCancelledError());
    const root = canonicalProjectPath(projectRoot);
    const revision = this.getRevision(root);
    let entry = this.active.get(root);
    if (!entry || entry.controller.signal.aborted || entry.revision !== revision) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.runScan(root, {
        isCancelled: () => controller.signal.aborted,
      }));
      entry = { promise, controller, subscribers: 0, revision };
      const created = entry;
      this.active.set(root, created);
      const clear = () => { if (this.active.get(root) === created) this.active.delete(root); };
      void promise.then(clear, clear);
    }
    const shared = entry;
    shared.subscribers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const release = () => {
        if (done) return false;
        done = true;
        signal?.removeEventListener('abort', onAbort);
        if (--shared.subscribers === 0) {
          shared.controller.abort();
          if (this.active.get(root) === shared) this.active.delete(root);
        }
        return true;
      };
      const onAbort = () => { if (release()) reject(new ScanCancelledError()); };
      signal?.addEventListener('abort', onAbort, { once: true });
      // Abort could have happened between the initial check and registration.
      if (signal?.aborted) onAbort();
      void shared.promise.then(
        (result) => { if (release()) resolve(result); },
        (error) => { if (release()) reject(error); },
      );
    });
  }
}

export const scanCoordinator = new ScanCoordinator();
