// Shared types, filenames, and renderer composition for Pi's completion
// backstop. Derives per-call inputs for the source assembly in `template.ts`.

import { appendSourceParam, renderExtensionSource } from './template.js';
import { callbackOutboxEntryPath } from '../callbackOutbox/paths.js';

export type PiExtensionSite =
  | 'task-complete'
  | 'push-run-done'
  | 'workflow-step-complete'
  | 'post-merge-hook-complete'
  | 'workflow-customization-complete';

export type PiCompletionExtensionOptions = {
  callbackUrl: string;
  /** Which call-site this extension serves. Tagged in the URL + sentinel for log correlation. */
  site: PiExtensionSite;
  /**
   * When `true`, only fire on `event.reason === 'quit'` (or unset). Use for
   * sites whose callback has a destructive side effect — task `/complete`
   * and push `/done`, which schedule a kill-by-cwd and
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
// section-assembly in `template.ts`.
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
