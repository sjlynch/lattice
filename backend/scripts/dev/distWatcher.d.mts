import type { watch } from 'node:fs';
export function watchDist(onChange: (eventType: string, filename: string | Buffer | null) => void,
  deps?: { watchNative?: typeof watch; loadChokidar?: () => Promise<unknown> }): Promise<() => void>;
