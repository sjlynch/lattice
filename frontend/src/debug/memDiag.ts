// Browser half of Lattice's memory debug output (backend: `backend/src/memDiag.ts`;
// overview in `backend/src/memDiag/CLAUDE.md`).
//
// Every `lattice.debug.memLogMs` milliseconds (localStorage; default 5 min,
// '0' disables) this tab samples its JS heap (Chrome's `performance.memory`)
// and every registered gauge, POSTs the sample to `/api/debug/client-memory`,
// and echoes the backend's formatted `[mem] browser#<tab> …` line to this
// console. The backend prints the same line in the `npm run dev` terminal,
// tracks a per-tab trend (`RISING: …` = climbed for ~30 min straight) and
// appends the full sample to `~/.lattice/logs/mem-browser.jsonl`.
//
// `window.__latticeMem()` prints every gauge on demand (console.table).
//
// A module owning a long-lived collection / GPU resource registers a gauge
// beside it: `registerMemGauge('area.thing', () => things.size)`. Readers run
// on every tick: keep them O(1)-cheap and side-effect free. A gauge for a
// per-instance resource returns its unregister function from the owner's
// cleanup (re-registering a name replaces the previous reader).

const gauges = new Map<string, () => number>();

export function registerMemGauge(name: string, read: () => number): () => void {
  gauges.set(name, read);
  return () => {
    if (gauges.get(name) === read) gauges.delete(name);
  };
}

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

registerMemGauge('dom.nodes', () => document.getElementsByTagName('*').length);
registerMemGauge('dom.canvases', () => document.getElementsByTagName('canvas').length);

// Lattice's tab runs the Vite DEV build for days while agents merge into its
// own frontend, so every merge hot-swaps modules into this page. ES module
// records are never unloaded; correlate heap growth against this count.
let hmrUpdates = 0;
registerMemGauge('vite.hmrUpdates', () => hmrUpdates);
if (import.meta.hot) {
  import.meta.hot.on('vite:afterUpdate', () => {
    hmrUpdates += 1;
  });
}

const INTERVAL_KEY = 'lattice.debug.memLogMs';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const MIN_INTERVAL_MS = 10_000;
const FIRST_SAMPLE_MS = 60_000;

function intervalMs(): number {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(INTERVAL_KEY);
  } catch {
    /* storage unavailable — default */
  }
  if (raw === null || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_MS;
  return n <= 0 ? 0 : Math.max(MIN_INTERVAL_MS, n);
}

// Short per-tab id so several open tabs stay distinguishable in the backend log.
function tabId(): string {
  const key = 'lattice.debug.memTab';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = Math.random().toString(36).slice(2, 6);
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 6);
  }
}

type ChromeMemory = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };

function heap(): ChromeMemory | null {
  const m = (performance as Performance & { memory?: ChromeMemory }).memory;
  return m && typeof m.usedJSHeapSize === 'number' ? m : null;
}

export function memSample() {
  const h = heap();
  return {
    tab: TAB,
    uptimeSec: Math.round(performance.now() / 1000),
    heapUsed: h?.usedJSHeapSize ?? null,
    heapTotal: h?.totalJSHeapSize ?? null,
    heapLimit: h?.jsHeapSizeLimit ?? null,
    gauges: readMemGauges(),
  };
}

const TAB = tabId();

async function tick(): Promise<void> {
  try {
    const r = await fetch('/api/debug/client-memory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(memSample()),
    });
    if (!r.ok) return;
    const { line } = (await r.json()) as { line?: string };
    if (typeof line === 'string') console.info(line);
  } catch {
    /* backend down — skip this sample */
  }
}

let started = false;

export function startMemDiag(): void {
  if (started) return;
  started = true;
  (window as Window & { __latticeMem?: () => unknown }).__latticeMem = () => {
    const s = memSample();
    console.table(s.gauges);
    return s;
  };
  const ms = intervalMs();
  if (ms <= 0) return;
  window.setTimeout(() => {
    void tick();
    window.setInterval(() => void tick(), ms);
  }, Math.min(FIRST_SAMPLE_MS, ms));
}
