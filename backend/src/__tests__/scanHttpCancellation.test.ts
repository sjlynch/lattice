import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { buildScanRouter } from '../routes/health/scan.js';
import { ScanCancelledError } from '../scanner/fileMetrics.js';
import type { ScanResult } from '../scanner/graphAggregate.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test('a completed incoming GET stays active until the response client disconnects', { timeout: 5000 }, async (t) => {
  const incomingClosed = deferred<void>();
  const started = deferred<AbortSignal>();
  const done = deferred<ScanResult>();
  const app = express();
  app.use((req, _res, next) => {
    req.once('close', () => incomingClosed.resolve());
    // Consume the GET, as normal request/body middleware may do. Modern Node
    // closes IncomingMessage after end, even while the response is held open.
    req.resume();
    next();
  });
  app.use(buildScanRouter('scan-http-fixture', async (_root, signal) => {
    assert.ok(signal);
    started.resolve(signal);
    return done.promise;
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${address.port}/api/scan`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    request.on('error', reject);
  });
  const signal = await started.promise;
  await incomingClosed.promise;
  assert.equal(signal.aborted, false, 'normal incoming-request close must not cancel a held GET');
  done.resolve({ root: 'scan-http-fixture', nodes: [], links: [] });
  const received = await response;
  assert.equal(received.status, 200);
  assert.equal(JSON.parse(received.body).root, 'scan-http-fixture');
  assert.equal(signal.aborted, false, 'normal response completion must not signal cancellation');
});

test('destroying a held GET response cancels its scan subscription', { timeout: 5000 }, async (t) => {
  const started = deferred<AbortSignal>();
  const cancelled = deferred<void>();
  const app = express();
  app.use(buildScanRouter('scan-http-fixture', async (_root, signal) => {
    assert.ok(signal);
    started.resolve(signal);
    return new Promise<ScanResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        cancelled.resolve();
        reject(new ScanCancelledError());
      }, { once: true });
    });
  }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = http.get(`http://127.0.0.1:${address.port}/api/scan`);
  request.on('error', () => {});
  const signal = await started.promise;
  request.destroy();
  await cancelled.promise;
  assert.equal(signal.aborted, true);
});
