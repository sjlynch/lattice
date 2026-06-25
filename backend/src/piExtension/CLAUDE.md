# backend/src/piExtension

Renders + installs Pi's `.pi/extensions/lattice-complete.ts` completion
backstop — Pi's analogue of the Claude Stop hook. It POSTs `/complete` (or a
site-specific callback) on `session_shutdown`, so a Pi session reports
completion even if the model forgets to curl. `../piExtension.ts` is the stable
public facade; every consumer imports from `'../piExtension.js'`.

One renderer feeds all four call-sites — task `/complete`,
workflow-step-complete, post-merge-hook-complete, and
workflow-customization-complete (the `PiExtensionSite` union) — so all backstops
share one hardening (retry loop + per-attempt timeout + sentinel audit log).

## Modules

- `template.ts` — *how the extension text is assembled*, no I/O. The banner
  comment, the `const` block, the static helper fns, and the `session_shutdown`
  handler, joined by `renderExtensionSource`. **The produced string is
  byte-significant** (Pi loads it verbatim; the on-disk up-to-date check compares
  it character-for-character) — reorganize the assembly freely, but never change
  the output bytes. `appendSourceParam` tags the callback URL with `?source=` so
  the backend can log which mechanism fired.
- `install.ts` — the filesystem side: `installPiCompletionExtension({dir, …})`
  writes (or skips, when contents already match, to avoid dirtying `git status`)
  the extension under `<dir>/.pi/extensions/`, plus `readPiShutdownSentinel` for
  diagnostics.

The facade (`../piExtension.ts`) owns the `PiExtensionSite` /
`PiCompletionExtensionOptions` types, the default filenames, and
`renderPiCompletionExtension` (derives the per-call inputs, then calls
`template.ts`); it re-exports the `install.ts` functions.

> Adding a call-site = add a `PiExtensionSite` value, pick a sentinel filename,
> decide whether to gate on `quit`, and call `installPiCompletionExtension`.
> Don't inline a fresh renderer.
