# backend/src/piExtension

Renders + installs Pi's `.pi/extensions/lattice-complete.ts` completion
backstop — Pi's analogue of the Claude Stop hook. It POSTs `/complete` (or a
site-specific callback) on `session_shutdown` by default, so a Pi session reports
completion even if the model forgets to curl. Interactive callers may choose
`eventName: 'agent_settled'` to report each completed turn without closing Pi. `../piExtension.ts` is the stable
public facade; external consumers import from `'../piExtension.js'`. Internal
modules import their implementation dependencies directly, never the facade.

One renderer feeds all call-sites — task `/complete`, push `/done`,
workflow-step-complete, post-merge-hook-complete, and
workflow-customization-complete, plus security-review-done
(the `PiExtensionSite` union) — so all backstops
share one hardening (retry loop + per-attempt timeout + sentinel audit log).
Security reviews use `agent_settled` (after retries/compaction/queued messages),
with no quit gate: the callback records awaiting-decision and preserves the
conversation. All existing shutdown callers keep byte-identical output.

## Modules

- `renderer.ts` — owns the `PiExtensionSite` /
  `PiCompletionExtensionOptions` types, default filenames, and
  `renderPiCompletionExtension`. Derives the source-tagged URL, callback-outbox
  path, and prompt-file literal, then calls `template.ts` without I/O.
- `template.ts` — *how the extension text is assembled*, no I/O. The banner
  comment, the `const` block, the static helper fns, and the `session_shutdown`
  handler (or its opt-in `agent_settled` variant), joined by `renderExtensionSource`.
  **The produced string is
  byte-significant** (Pi loads it verbatim; the on-disk up-to-date check compares
  it character-for-character) — reorganize the assembly freely, but never change
  the output bytes. `appendSourceParam` tags the callback URL with `?source=` so
  the backend can log which mechanism fired.
- `install.ts` — the filesystem side: `installPiCompletionExtension({dir, …})`
  writes (or skips, when contents already match, to avoid dirtying `git status`)
  the extension under `<dir>/.pi/extensions/`, plus `readPiShutdownSentinel` for
  diagnostics. Imports its renderer, types, and defaults from `renderer.ts`.

The facade (`../piExtension.ts`) re-exports the public types, defaults, and
renderer from `renderer.ts`, plus the installer and sentinel reader from
`install.ts`, preserving existing import paths without implementation logic.

> Adding a call-site = add a `PiExtensionSite` value, pick a sentinel filename,
> decide whether to gate on `quit`, and call `installPiCompletionExtension`.
> Don't inline a fresh renderer.
