# frontend/src/components/shared

Small reusable UI primitives with no feature ownership.

- `ConfirmDialog` is the generic confirmation modal used by destructive or
  unsaved-change flows; callers own wording and side effects.
- `ErrorToast` is the lightweight toast renderer; feed it already-shaped user
  messages from feature hooks/controllers.
- `useAutoDismissMessage(dismissMs = TOAST_DISMISS_MS)` (5000) is the one toast-slot timer → `{message, setMessage, show, clear}`; `show` re-arms a single timer that clears only an unchanged message, unmount clears it (users: `useTaskList`, `useWorkflowErrorHandler`; test `__tests__/useAutoDismissMessage.test.ts`). Don't hand-roll another.
- `useEscapeToClose(open, onClose)`: innermost-wins Escape (layer stack; only the top layer's capture listener acts, then `stopPropagation`). Users: `Modal` (so `ConfirmDialog`), `TaskDetailOverlay`, `NewTaskOverlay`; test `__tests__/escapeInnermost.test.ts`.
  **A new dialog/overlay that closes on Escape must use it, never its own `window` keydown listener** — else one Escape closes every layer behind it too.
- Keep this folder dependency-light: shared components may depend on generic
  CSS/classes, but should not import taskboard/workflow/settings-specific state.
- If a component grows feature-specific props or behavior, move it back under
  that feature instead of expanding this shared surface.
