# frontend/src/components/shared

Small reusable UI primitives with no feature ownership.

- `ConfirmDialog` is the generic confirmation modal used by destructive or
  unsaved-change flows; callers own wording and side effects.
- `ErrorToast` is the lightweight toast renderer; feed it already-shaped user
  messages from feature hooks/controllers.
- `useEscapeToClose(open, onClose)`: innermost-wins Escape (layer stack; only the top layer's capture listener acts, then `stopPropagation`). Users: `Modal` (so `ConfirmDialog`), `TaskDetailOverlay`, `NewTaskOverlay`; test `__tests__/escapeInnermost.test.ts`.
  **A new dialog/overlay that closes on Escape must use it, never its own `window` keydown listener** — else one Escape closes every layer behind it too.
- Keep this folder dependency-light: shared components may depend on generic
  CSS/classes, but should not import taskboard/workflow/settings-specific state.
- If a component grows feature-specific props or behavior, move it back under
  that feature instead of expanding this shared surface.
