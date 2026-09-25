// Stable public facade for the completion-callback outbox. Implementation
// lives in `callbackOutbox/` (see its CLAUDE.md).

export {
  callbackOutboxDir,
  callbackOutboxEntryPath,
  callbackOutboxKey,
  callbackScriptPath,
} from './callbackOutbox/paths.js';
export {
  CALLBACK_HOOK_BUDGET_MS,
  CALLBACK_HOOK_TIMEOUT_S,
  claudeCallbackCommand,
  codexCallbackCommands,
  ensureCallbackScript,
  renderCallbackScript,
  retryingCurl,
} from './callbackOutbox/script.js';
export {
  drainCallbackOutbox,
  isFinalStatus,
  isReplayableUrl,
  OUTBOX_MAX_AGE_MS,
  replayBackoffMs,
  startCallbackOutboxLoop,
  type DrainResult,
  type OutboxEntry,
} from './callbackOutbox/drain.js';
