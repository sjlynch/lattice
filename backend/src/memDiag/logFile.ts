// Durable memory time series: one JSON object per sample appended to
// `~/.lattice/logs/mem-<label>.jsonl`, rotated to `mem-<label>.prev.jsonl`
// past MAX_BYTES (so at most ~2 × MAX_BYTES per label on disk). The console
// line is for watching; this file is for an agent to diff hours of samples
// after a leak has already happened. Best-effort: I/O errors are swallowed.

import fs from 'node:fs/promises';
import path from 'node:path';

import { crashLogDir } from '../crashLog.js';

const MAX_BYTES = 2 * 1024 * 1024;

let chain: Promise<void> = Promise.resolve();

export function memLogPath(label: string): string {
  return path.join(crashLogDir(), `mem-${label}.jsonl`);
}

async function appendOne(label: string, record: unknown): Promise<void> {
  const file = memLogPath(label);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const st = await fs.stat(file);
    if (st.size > MAX_BYTES) {
      await fs.rename(file, path.join(path.dirname(file), `mem-${label}.prev.jsonl`));
    }
  } catch {
    /* absent — first write creates it */
  }
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
}

// Serialized so a rotation can't interleave with a concurrent append.
export function appendMemRecord(label: string, record: unknown): void {
  chain = chain.then(() => appendOne(label, record)).catch(() => {});
}
