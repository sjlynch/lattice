import type { GitHistoryResult } from '../../../api';

type Callbacks = {
  load: (signal: AbortSignal) => Promise<GitHistoryResult>;
  onHistory: (history: GitHistoryResult) => void;
  onError: () => void;
};

// One active history request per mounted project. Status signatures are hints:
// a response may already contain a newer git state than the event that started
// it. Only a DIFFERENT event received during the request requires a follow-up,
// and even that is satisfied if the response already carries its signature.
export function createGitHistoryRefresh({ load, onHistory, onError }: Callbacks) {
  type Request = {
    controller: AbortController;
    signature: string | undefined;
    pending: string | undefined;
  };
  let active: Request | null = null;
  let lastSignature: string | undefined;
  let disposed = false;

  function start(signature?: string) {
    if (disposed || active) return;
    const request: Request = {
      controller: new AbortController(), signature, pending: undefined,
    };
    active = request;
    void (async () => {
      let history: GitHistoryResult | undefined;
      try {
        history = await load(request.controller.signal);
      } catch {
        // Completion below decides whether a newer event superseded failure.
      }
      if (disposed || active !== request) return;
      active = null;

      const pending = request.pending;
      if (pending !== undefined && history?.signature !== pending) {
        // Avoid publishing an obsolete ghost/change set only to replace it on
        // the next response. Any number of intervening events collapse here.
        start(pending);
      } else if (history) {
        lastSignature = history.signature;
        onHistory(history);
      } else {
        onError();
      }
    })();
  }

  function notifySignature(signature: string) {
    if (disposed) return;
    if (active) {
      // Check the active request before lastSignature: a return to the last
      // good state still supersedes an in-flight request for a different one.
      const latest = active.pending ?? active.signature;
      if (signature !== latest) active.pending = signature;
      return;
    }
    if (signature !== lastSignature) start(signature);
  }

  function dispose() {
    disposed = true;
    active?.controller.abort();
    active = null;
  }

  return { start: () => start(), notifySignature, dispose };
}
