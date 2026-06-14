// Facade preserving the original public surface of this module after the
// detection-vs-template split. Project stack detection (which frameworks a
// project uses + the guidance derived from that) now lives in
// `projectStackDetection.ts`; prompt-template matching and project-aware
// prompt-variant generation live in `promptTemplates.ts`. Importers keep
// importing from here so nothing downstream had to change.
export * from './projectStackDetection.ts';
export * from './promptTemplates.ts';
