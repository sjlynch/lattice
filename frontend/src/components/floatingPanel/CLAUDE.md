# frontend/src/components/floatingPanel

- `geometry.ts` owns viewport padding, position clamping, initial placement, and the persisted `{ pos, size }` localStorage shape.
- `hooks.ts` owns FloatingPanel state persistence plus Escape, drag, and resize document-listener lifecycles, and the `maximized`/`toggleMaximize` toggle; `../FloatingPanel.tsx` should stay focused on portal markup and wiring.
- Maximize/restore (OS-window style): double-clicking the titlebar (or the top-right maximize icon next to Close) fills the window; toggling back restores the exact prior `pos`/`size` (left untouched while maximized). Drag/resize are disabled while maximized. Titlebar controls carry `.fp-no-drag` so a double-click on the search box / buttons never maximizes.
