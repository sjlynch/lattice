import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MemTrend, TREND_WINDOW } from '../memDiag/trend.js';
import { readMemGauges, registerMemGauge } from '../memDiag/gauges.js';
import { fmtHandles, formatMemLine, topGaugeGrowth } from '../memDiag/format.js';
import { sampleSeries, takeMemSample } from '../memDiag/sample.js';
import { memDiagIntervalMs } from '../memDiag.js';
import { parseBrowserMemSample } from '../memDiag/browser.js';

const MiB = 1024 * 1024;

function feed(trend: MemTrend, values: number[], name = 'x.count'): void {
  for (const v of values) trend.push({ [name]: v });
}

test('trend: a metric that climbs for the whole window is rising', () => {
  const t = new MemTrend();
  feed(t, [10, 12, 12, 15, 18, 30]);
  assert.deepEqual(t.rising(), [{ name: 'x.count', from: 10, to: 30 }]);
});

test('trend: any dip within the window clears the signal (GC saw-tooth)', () => {
  const t = new MemTrend();
  feed(t, [10, 12, 11, 15, 18, 30]);
  assert.deepEqual(t.rising(), []);
});

test('trend: needs a full window and a meaningful amount of growth', () => {
  const short = new MemTrend();
  feed(short, [1, 2, 3, 4, 50].slice(0, TREND_WINDOW - 1));
  assert.deepEqual(short.rising(), []);

  const flat = new MemTrend();
  feed(flat, [100, 100, 101, 101, 102, 103]);
  assert.deepEqual(flat.rising(), [], 'count growth under max(4, 20%) is noise');

  const bytes = new MemTrend();
  feed(bytes, [100, 101, 102, 103, 104, 105].map((n) => n * MiB), 'mem.heapUsed');
  assert.deepEqual(bytes.rising(), [], 'byte growth under max(8MB, 10%) is noise');
  feed(bytes, [120 * MiB], 'mem.heapUsed');
  assert.equal(bytes.rising().length, 1);
});

test('trend: a metric that disappears from the series is forgotten', () => {
  const t = new MemTrend();
  feed(t, [1, 5, 10, 20, 40, 80]);
  t.push({});
  assert.deepEqual(t.rising(), []);
});

test('gauges: a throwing or non-finite reader reports -1 instead of failing', () => {
  registerMemGauge('test.ok', () => 7);
  registerMemGauge('test.throws', () => {
    throw new Error('boom');
  });
  registerMemGauge('test.nan', () => Number.NaN);
  const g = readMemGauges();
  assert.equal(g['test.ok'], 7);
  assert.equal(g['test.throws'], -1);
  assert.equal(g['test.nan'], -1);
});

test('sample: flattens into mem.* / handles.* / gauge namespaces', () => {
  const series = sampleSeries(takeMemSample());
  assert.ok(series['mem.rss'] > 0);
  assert.ok('handles.total' in series);
  assert.equal(series['test.ok'], 7);
});

test('format: one line with headline, growth and rising metrics', () => {
  const line = formatMemLine({
    label: 'backend',
    uptimeSec: 3 * 3600 + 5 * 60,
    headline: ['rss 200MB', fmtHandles({ Timeout: 3, TCPSocketWrap: 9, FSEventWrap: 1 }, 2)],
    growth: topGaugeGrowth({ a: 1, b: 5 }, { a: 4, b: 5, c: 2 }),
    rising: [{ name: 'mem.heapUsed', from: 50 * MiB, to: 90 * MiB }],
  });
  assert.equal(
    line,
    '[mem] backend up 3h05m · rss 200MB · handles 13 (TCPSocketWrap 9, Timeout 3) · ' +
      'grew since start: a +3, c +2 · RISING: mem.heapUsed 50MB→90MB',
  );
  assert.ok(!line.includes('\n'));
});

test('interval: default 5 min, 0 disables, floor 10 s, junk falls back', () => {
  assert.equal(memDiagIntervalMs({}), 300_000);
  assert.equal(memDiagIntervalMs({ LATTICE_MEM_LOG_MS: '0' }), 0);
  assert.equal(memDiagIntervalMs({ LATTICE_MEM_LOG_MS: '5' }), 10_000);
  assert.equal(memDiagIntervalMs({ LATTICE_MEM_LOG_MS: '60000' }), 60_000);
  assert.equal(memDiagIntervalMs({ LATTICE_MEM_LOG_MS: 'soon' }), 300_000);
});

test('browser sample: validates the tab id and drops junk gauges', () => {
  assert.equal(parseBrowserMemSample(null), null);
  assert.equal(parseBrowserMemSample({ tab: '../etc' }), null);
  const s = parseBrowserMemSample({
    tab: 'ab12',
    uptimeSec: 61.6,
    heapUsed: 10,
    heapTotal: 'x',
    gauges: { 'dom.nodes': 900, 'bad key!': 1, 'gl.textures': Number.POSITIVE_INFINITY },
  });
  assert.deepEqual(s, {
    tab: 'ab12',
    uptimeSec: 62,
    heapUsed: 10,
    heapTotal: null,
    heapLimit: null,
    gauges: { 'dom.nodes': 900 },
  });
});
