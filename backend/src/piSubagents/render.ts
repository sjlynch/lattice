// Pure rendering of the discovery shim source.
//
// Pi auto-discovers `<cwd>/.pi/extensions/*.ts` — but cwd-EXACT (verified: it
// does NOT walk up parent dirs). Lattice already drops `lattice-complete.ts`
// there for the completion backstop; the shim is a sibling `lattice-subagents.ts`
// whose only content re-exports the shared install's default export. Pi loads
// it, the extension's peer deps (`@earendil-works/pi-*`) resolve through Pi's
// own loader (verified), and the `Agent` / `get_subagent_result` /
// `steer_subagent` tools register.

// Filename of the discovery shim, dropped alongside `lattice-complete.ts`. Pi
// auto-loads any `.ts` in `.pi/extensions/`, so no settings entry is needed.
export const PI_SUBAGENTS_SHIM_FILENAME = 'lattice-subagents.ts';

// Pure renderer for the discovery shim — exported for unit testing.
export function renderPiSubagentsShim(entry: string): string {
  return `// Lattice-managed — do not commit. Loads the @tintinweb/pi-subagents
// extension from Lattice's shared install so Pi sub-agents are available in
// this Lattice Pi session WITHOUT a global \`pi install\` (your
// ~/.pi/agent/settings.json stays untouched). Pi auto-discovers any .ts in this
// directory; this file just re-exports the extension's default activation fn.
export { default } from ${JSON.stringify(entry)};
`;
}
