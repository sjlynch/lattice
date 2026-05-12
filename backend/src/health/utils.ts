import type { HealthSmell } from './types.js';
import { SMELL_LABELS } from './types.js';
import type { SmellCounter } from './universal.js';

export function smellsToArray(smells: SmellCounter): HealthSmell[] {
  const out: HealthSmell[] = [];
  for (const [id, count] of smells) {
    if (count > 0) out.push({ id, count, label: SMELL_LABELS[id] });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}
