// Named size gauges for the memory debug line (see ../memDiag.ts).
//
// A module that owns a long-lived collection registers a gauge BESIDE the
// collection: `registerMemGauge('area.thing', () => things.size)`. The gauge
// is read on every memDiag tick, so it must be O(1)-cheap and side-effect
// free. Re-registering a name replaces the previous reader (module reloads
// in tests stay idempotent). Keep this file dependency-free: the detached
// terminal-server imports it too, and every executor import is fingerprinted.

export type MemGaugeRead = () => number;

const gauges = new Map<string, MemGaugeRead>();

export function registerMemGauge(name: string, read: MemGaugeRead): void {
  gauges.set(name, read);
}

// Every registered gauge, sorted by name. A reader that throws or returns a
// non-finite value reports -1 so a broken gauge is visible, not fatal.
export function readMemGauges(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of [...gauges.keys()].sort()) {
    let value = -1;
    try {
      const v = gauges.get(name)!();
      if (Number.isFinite(v)) value = v;
    } catch {
      /* reported as -1 */
    }
    out[name] = value;
  }
  return out;
}
