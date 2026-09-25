// Shared renderer + installer for Pi's `.pi/extensions/lattice-complete.ts`
// completion backstop. Replaces the three near-identical inline renderers
// previously inlined in worktree/stopHook.ts, postMergeHooks/stopHook.ts,
// and workflowRuns/stepSpawner.ts so all backstops get the same hardening
// in one place:
//
//   1. Configurable shutdown-reason gate. The original snippet only fired
//      on `reason === 'quit'` to avoid flipping a task on `/new`, `/reload`,
//      `/fork` — for sites with a kill-by-cwd side effect this is right;
//      for sites without it (workflow steps, post-merge hooks, prompt
//      customization) we accept any shutdown reason so abnormal exits
//      still produce a callback.
//   2. A short timeout on the POST so a wedged backend doesn't strand
//      session_shutdown.
//   3. A small retry loop so a transient socket / DNS hiccup during
//      shutdown isn't immediately fatal.
//   4. A sentinel file written next to the extension that records the
//      reason, attempt count, outcome, and any error message. Lets us
//      diagnose Pi-side reliability issues without server-side guessing —
//      "did the extension fire? did the POST succeed?" is now visible
//      on disk.
//   5. Optional `promptFile` mode for the prompt-customization endpoint:
//      reads the file the model wrote and POSTs it as JSON `{prompt}`.
//
// Adding a new Pi-extension call-site = add a `PiExtensionSite` value,
// pick a sentinel filename, decide whether to gate on `quit`, and call
// `installPiCompletionExtension`. Don't inline a fresh copy.
//
// This file is the stable public facade. The extension source template lives
// in `piExtension/template.ts` (how the generated TS is assembled) and the
// filesystem install + sentinel-read logic lives in `piExtension/install.ts`.
// Keep all three public-export names below stable — callers import them from
// `./piExtension.js`.

import { appendSourceParam, renderExtensionSource } from './piExtension/template.js';
import { callbackOutboxEntryPath } from './callbackOutbox/paths.js';

export type PiExtensionSite =
  | 'task-complete'
  | 'workflow-step-complete'
  | 'post-merge-hook-complete'
  | 'workflow-customization-complete';

export type PiCompletionExtensionOptions = {
  callbackUrl: string;
  /** Which call-site this extension serves. Tagged in the URL + sentinel for log correlation. */
  site: PiExtensionSite;
  /**
   * When `true`, only fire on `event.reason === 'quit'` (or unset). Use for
   * sites whose callback has a destructive side effect — currently only the
   * task `/complete` endpoint, which schedules a kill-by-cwd 1s later and
   * would yank a `/fork`'d pty out from under an interactive user.
   * Other sites should set this to `false` so abnormal-exit reasons still
   * trigger the callback.
   */
  respectQuitGate: boolean;
  /**
   * If provided (absolute path), read this file at shutdown and POST its
   * contents as JSON `{prompt: <contents>}`. Used by the workflow
   * prompt-customization backstop. Otherwise POSTs an empty body.
   */
  promptFile?: string;
  /** Absolute path to the extension `.ts` file. */
  extensionFile: string;
  /** Absolute path to the sentinel `.json` audit log written next to the extension. */
  sentinelFile: string;
};

// Filename for the per-site sentinel (lives alongside the extension under
// `.pi/extensions/`). Pi auto-loads any `.ts` in that dir, so we keep the
// sentinel as `.json` so it isn't itself executed as an extension.
export function defaultPiSentinelFileName(): string {
  return 'lattice-last-shutdown.json';
}

export function defaultPiExtensionFileName(): string {
  return 'lattice-complete.ts';
}

// Render the extension source. The per-call inputs (source-tagged URL, the
// `null`-or-JSON prompt-file literal) are derived here, then handed to the
// section-assembly in `piExtension/template.ts`.
export function renderPiCompletionExtension(
  opts: PiCompletionExtensionOptions,
): string {
  const { callbackUrl, site, respectQuitGate, promptFile, sentinelFile } = opts;
  const urlWithSource = appendSourceParam(callbackUrl, `pi-extension-${site}`);
  const promptFileLiteral = promptFile ? JSON.stringify(promptFile) : 'null';

  return renderExtensionSource({
    urlWithSource,
    sentinelFile,
    outboxFile: callbackOutboxEntryPath(urlWithSource),
    promptFileLiteral,
    site,
    respectQuitGate,
  });
}

// Re-export the filesystem surface so existing callers keep importing
// everything from `./piExtension.js`.
export {
  installPiCompletionExtension,
  readPiShutdownSentinel,
} from './piExtension/install.js';
