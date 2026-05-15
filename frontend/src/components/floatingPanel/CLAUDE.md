# frontend/src/components/floatingPanel

- `geometry.ts` owns viewport padding, position clamping, initial placement, and the persisted `{ pos, size }` localStorage shape.
- `hooks.ts` owns FloatingPanel state persistence plus Escape, drag, and resize document-listener lifecycles; `../FloatingPanel.tsx` should stay focused on portal markup and wiring.
