# frontend/src/components/shared

Small reusable UI primitives with no feature ownership.

- `ConfirmDialog` is the generic confirmation modal used by destructive or
  unsaved-change flows; callers own wording and side effects.
- `ErrorToast` is the lightweight toast renderer; feed it already-shaped user
  messages from feature hooks/controllers.
- Keep this folder dependency-light: shared components may depend on generic
  CSS/classes, but should not import taskboard/workflow/settings-specific state.
- If a component grows feature-specific props or behavior, move it back under
  that feature instead of expanding this shared surface.
