import { computeCrossFile, type FileImports } from '../health/index.js';
import type { ParsedAlias } from '../health/tsconfig.js';
import type { FileMetric } from './fileMetrics.js';

export type CouplingMap = ReturnType<typeof computeCrossFile>;

export function computeCoupling(
  metrics: FileMetric[],
  aliases?: readonly ParsedAlias[],
  roots?: Set<string>,
): CouplingMap {
  const fileImports: FileImports[] = [];
  const presentFiles = new Set<string>();
  for (const metric of metrics) {
    presentFiles.add(metric.filePath);
    if (metric.healthDetails) {
      fileImports.push({ filePath: metric.filePath, imports: metric.imports });
    }
  }
  return computeCrossFile(fileImports, presentFiles, aliases, { roots });
}
