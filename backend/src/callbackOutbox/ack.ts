import fs from 'node:fs/promises';
import type { RequestHandler } from 'express';
import { callbackOutboxDir, callbackOutboxEntryPath } from './paths.js';
import { isFinalStatus } from './drain.js';

// Backend-side acknowledgement: once a completion callback has been ANSWERED,
// remove its outbox entry here instead of relying on the hook to do it.
//
// The hook can't always: several callbacks tear down the very session that
// sent them — push `/done` and QA `/done` clean up their scratch session, a
// workflow step's advance kills its pty — and the callback script runs INSIDE
// that session's process tree, so it can be killed between the response and
// its own unlink. The entry would then sit there until the drain replayed it
// (harmless — every endpoint is idempotent — but a pointless second request,
// possibly minutes later, against state that has moved on).
//
// Keyed exactly like the hook (full URL incl. `?source=`), so it only ever
// touches the entry for this request. 5xx / 408 / 429 leave it: the hook or
// the drain retries those.

const CALLBACK_PATH_RE =
  /\/(?:complete|done|verdict|merged|merge-aborted|stash-resolved)$/;

export function buildCallbackOutboxAck(backendOrigin: string, dir = callbackOutboxDir()): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'POST' || !CALLBACK_PATH_RE.test(req.path)) return next();
    const url = `${backendOrigin}${req.originalUrl}`;
    res.on('finish', () => {
      if (!isFinalStatus(res.statusCode)) return;
      fs.unlink(callbackOutboxEntryPath(url, dir)).catch(() => {});
    });
    next();
  };
}
