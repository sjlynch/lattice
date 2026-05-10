# frontend/src/components/legend

The right-side legend overlay's two modes: the default extension legend (shape +
color per file extension) and the `h`-key code-health breakdown panel. Which one
renders is driven by the App-level `healthMode` prop.

## Files

- `HealthLegendPanel.tsx` — the static health-component breakdown shown while `h`
  is held: each metric's weight, thresholds, and what it measures
- `ShapePreview.tsx` — small canvas preview of an extension's sprite shape, also
  reused inside the regular Legend's per-extension rows

Per-extension shapes and colors come from `frontend/src/extensionStyles.ts` —
the single source of truth shared by the 3D graph and this legend.
