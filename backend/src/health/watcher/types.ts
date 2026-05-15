import type { FSWatcher } from 'chokidar';
import type { HealthCache } from '../cache.js';
import type { ConfigReloader } from '../configReloader.js';
import type { CrossFileAnalyzer } from '../crossFileAnalyzer.js';
import type { HealthMetrics } from '../types.js';

export type HealthUpdate = {
  type: 'updated';
  filePath: string;
  metrics: HealthMetrics;
} | {
  type: 'removed';
  filePath: string;
};

export type Subscriber = (update: HealthUpdate) => void;

export type ProjectWatcher = {
  root: string;
  watcher: FSWatcher;
  cache: HealthCache;
  // Per-project import map kept in memory for cross-file recompute on every
  // change. Hydrated from the on-disk cache when the watcher boots so the FIRST
  // file save reports correct fanIn/fanOut instead of zeros (the cache holds the
  // post-cross-file metrics from the last scan).
  imports: Map<string, string[]>;
  metrics: Map<string, HealthMetrics>;
  config: ConfigReloader;
  crossFile: CrossFileAnalyzer;
  subscribers: Set<Subscriber>;
};
