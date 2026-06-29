# graphSettingsPanel

Small UI-only modules for the floating graph settings panel. `config.ts` owns
labels/ranges/toggle metadata and `controls.tsx` owns reusable row components.
Keep persisted key names backwards-compatible via `tabStorage.ts` and the shared
`latticeLocalStorage` key builders.
