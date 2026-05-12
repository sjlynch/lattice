import type { HealthMetrics } from './types.js';
import type { ParsedAlias } from './tsconfig.js';
import {
  applyCrossFile,
  computeCrossFile,
  type FileImports,
} from './crossFile.js';

// Snapshot of cross-file fields per file; used to detect which files were
// affected by a change so the watcher can broadcast updates for them too.
type CrossFileSnapshot = Map<
  string,
  { score: number; fanIn: number; fanOut: number; inCycle: boolean }
>;

export function snapshotCrossFile(metrics: Map<string, HealthMetrics>): CrossFileSnapshot {
  const out: CrossFileSnapshot = new Map();
  for (const [fp, m] of metrics) {
    out.set(fp, {
      score: m.score,
      fanIn: m.fanIn ?? 0,
      fanOut: m.fanOut ?? 0,
      inCycle: m.inCycle ?? false,
    });
  }
  return out;
}

export class CrossFileAnalyzer {
  constructor(
    private readonly options: {
      imports: Map<string, string[]>;
      metrics: Map<string, HealthMetrics>;
      getAliases: () => readonly ParsedAlias[];
      broadcastUpdated: (filePath: string, metrics: HealthMetrics) => void;
    },
  ) {}

  // Re-run the full project cross-file pass and broadcast every file whose
  // score / fanIn / fanOut / inCycle changed. Used both after a single-file
  // edit and after tsconfig/.gitignore reloads (which can resolve previously-
  // unresolved imports across many files at once).
  recomputeAndBroadcast(originatorPath: string | null): void {
    const { imports, metrics, getAliases, broadcastUpdated } = this.options;
    const before = snapshotCrossFile(metrics);
    const fileImports: FileImports[] = [];
    for (const [fp, ims] of imports) {
      fileImports.push({ filePath: fp, imports: ims });
    }

    const presentFiles = new Set(metrics.keys());
    const cross = computeCrossFile(fileImports, presentFiles, getAliases());
    applyCrossFile(metrics, cross);

    // Always broadcast the originator (its smells / score may have changed even
    // when no cross-file fields did). Then walk the diff for everyone else.
    const broadcasted = new Set<string>();
    if (originatorPath) {
      const m = metrics.get(originatorPath);
      if (m) {
        broadcastUpdated(originatorPath, m);
        broadcasted.add(originatorPath);
      }
    }

    for (const [fp, m] of metrics) {
      if (broadcasted.has(fp)) continue;
      const prev = before.get(fp);
      if (
        !prev ||
        prev.score !== m.score ||
        prev.fanIn !== (m.fanIn ?? 0) ||
        prev.fanOut !== (m.fanOut ?? 0) ||
        prev.inCycle !== (m.inCycle ?? false)
      ) {
        broadcastUpdated(fp, m);
      }
    }
  }
}
