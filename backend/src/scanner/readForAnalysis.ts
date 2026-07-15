import fs from 'node:fs/promises';
import { LOC_MAX_BYTES, isMinifiedForAnalysis } from '../health/constants.js';

export type ReadResult = {
  loc?: number;
  content?: string;
};

// Read the file once, count newlines, and return the decoded content
// when small enough for the health analyzer. Two cutoffs:
//   - LOC_MAX_BYTES (5 MB): skip both LOC and health entirely.
//   - minified-bundle heuristic (isMinifiedForAnalysis): keep the LOC count
//     (newline counting is fast) but DROP the content so analyzeFile / the
//     universal smell regexes never see a multi-MB minified bundle. See the
//     rationale on isMinifiedForAnalysis in health/constants.ts.
//
// Lives in its own module (not fileMetrics.ts) so the health-analysis WORKER
// can import just this + analyze.js without dragging in the worker coordinator
// that fileMetrics depends on. fileMetrics re-exports it for back-compat.
export async function readForAnalysis(filePath: string): Promise<ReadResult> {
  try {
    const buf = await fs.readFile(filePath);
    if (buf.length === 0) return { loc: 0, content: '' };
    if (buf.length > LOC_MAX_BYTES) return {};
    let count = 0;
    let idx = 0;
    while ((idx = buf.indexOf(0x0a, idx)) !== -1) {
      count++;
      idx++;
    }
    if (buf[buf.length - 1] !== 0x0a) count++;

    if (isMinifiedForAnalysis(buf.length, count)) return { loc: count };

    return { loc: count, content: buf.toString('utf8') };
  } catch {
    return {};
  }
}
