// Public facade for the env-detector catalog. The static data table +
// marker/lockfile constants live in `catalog.ts`; the marker-evaluation
// helpers live in `markers.ts`. This module re-exports both so existing
// `./envDetect/detectors.js` import paths and exported names stay unchanged.

export type { EnvKind, DetectedEnv, Detector } from './catalog.js';
export { DOTNET_MARKER_EXTENSIONS, LOCKFILE_NAMES, DETECTORS } from './catalog.js';
export { hasDetectorMarker } from './markers.js';
