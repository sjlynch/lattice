# frontend/src/components/legend

The right-side legend overlay's two modes: the default extension legend (shape +
color per file extension) and the `h`-key code-health breakdown panel. Which one
renders is driven by the App-level `healthMode` prop.

## Files

- `HealthLegendPanel.tsx` — the health legend panel layout shown while `h` is held
- `healthComponents.ts` — health-component UI labels/detail copy. Score ids,
  weights, thresholds, and ordering are imported from the backend's serializable
  `backend/src/health/scoreMetadata.ts`; do not duplicate those values here.
- `HealthInfoIcon.tsx` — info icon and portal-rendered popover for each health row
- `LegendRow.tsx` — render-only extension row button used by the default legend
- `useLegendRows.ts` — extension tallying plus visible/all-known row derivation
- `ShapePreview.tsx` — small canvas preview of an extension's sprite shape, also
  reused inside the regular Legend's per-extension rows

Per-extension shapes and colors come from `frontend/src/extensionStyles.ts` —
the single source of truth shared by the 3D graph and this legend. Health score
metadata comes from `backend/src/health/scoreMetadata.ts`; backend `scoreModel.ts`
adds only the metric extractor functions used by scoring.
