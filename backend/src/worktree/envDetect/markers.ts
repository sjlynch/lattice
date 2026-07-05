// Marker-evaluation helpers over the static `DETECTORS` catalog: given a
// repo root's directory listing, decide whether a detector's marker files or
// extensions are present. Pure logic — the data table lives in `catalog.ts`.

import path from 'node:path';
import type { Detector } from './catalog.js';

function hasRootFileWithExtension(
  rootEntries: string[],
  extensions: readonly string[],
): boolean {
  return rootEntries.some((name) =>
    extensions.includes(path.extname(name).toLowerCase()),
  );
}

export function hasDetectorMarker(
  detector: Detector,
  rootEntries: string[],
  rootSet: Set<string>,
): boolean {
  return (
    detector.markerFiles.some((marker) => rootSet.has(marker)) ||
    (detector.markerExtensions
      ? hasRootFileWithExtension(rootEntries, detector.markerExtensions)
      : false)
  );
}
