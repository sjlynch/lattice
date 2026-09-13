import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { getObservedTerminalTitle } from '../terminalActivityRelay.js';

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'fixture condition did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('real relay observes existing output without extra connections, writes, or byte changes', async (t) => {
  const upstreamServer = http.createServer();
  const upstreamWss = new WebSocketServer({ server: upstreamServer });
  const relayServer = http.createServer();
  const relayWss = new WebSocketServer({ server: relayServer });
  const relaySockets: WebSocket[] = [];
  const upstreams: Array<{ ws: WebSocket; url: string; input: Array<{ data: Buffer; binary: boolean }> }> = [];
  const browsers = new Set<WebSocket>();
  upstreamWss.on('connection', (ws, req) => {
    const entry = { ws, url: req.url!, input: [] as Array<{ data: Buffer; binary: boolean }> };
    upstreams.push(entry);
    ws.on('message', (data, binary) => entry.input.push({ data: Buffer.from(data as Buffer), binary }));
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const oldPort = process.env.TERMINAL_PORT;
  process.env.TERMINAL_PORT = String((upstreamServer.address() as AddressInfo).port);
  const { proxyTerminalWs } = await import('../terminalWsRelay.js');
  relayWss.on('connection', (ws, req) => {
    relaySockets.push(ws);
    proxyTerminalWs(ws, req.url);
  });
  await new Promise<void>((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
  const base = `ws://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

  t.after(async () => {
    for (const browser of browsers) browser.terminate();
    for (const ws of relayWss.clients) ws.terminate();
    for (const ws of upstreamWss.clients) ws.terminate();
    await Promise.all([
      new Promise<void>((resolve) => relayWss.close(() => resolve())),
      new Promise<void>((resolve) => upstreamWss.close(() => resolve())),
      new Promise<void>((resolve) => relayServer.close(() => resolve())),
      new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
    ]);
    if (oldPort === undefined) delete process.env.TERMINAL_PORT;
    else process.env.TERMINAL_PORT = oldPort;
  });

  async function connect(query: string) {
    const before = upstreams.length;
    const browser = new WebSocket(`${base}/ws/terminal?${query}`);
    browsers.add(browser);
    const output: Array<{ data: Buffer; binary: boolean }> = [];
    browser.on('message', (data, binary) => output.push({ data: Buffer.from(data as Buffer), binary }));
    await once(browser, 'open');
    await until(() => upstreams.length === before + 1);
    return { browser, upstream: upstreams[before], output };
  }

  const first = await connect('id=query-is-not-authority&initialCommand=codex');
  assert.equal(new URL(first.upstream.url, base).searchParams.get('initialCommand'), 'codex', 'reattach never rewrites the old command');
  first.upstream.ws.send(JSON.stringify({ type: 'data', data: '\x1b]0;Working\x07' }));
  await until(() => first.output.length === 1);
  assert.equal(getObservedTerminalTitle('query-is-not-authority'), undefined);
  const frames = [
    { data: Buffer.from(' {"type":"attached", "id":"relay-live", "replayed":true} '), binary: false },
    { data: Buffer.from(JSON.stringify({ type: 'data', data: '\x1b]0;Working\x07old replay\x1b]0;Ready\x07' })), binary: false },
    { data: Buffer.from(JSON.stringify({ type: 'data', data: '\x1b]0;Working\x07' })), binary: true },
    { data: Buffer.from('{invalid json'), binary: false },
  ];
  for (const message of frames) first.upstream.ws.send(message.data, { binary: message.binary });
  await until(() => first.output.length === frames.length + 1);
  assert.deepEqual(first.output.slice(1), frames, 'forward exactly the original bytes and frame types');
  assert.equal(getObservedTerminalTitle('relay-live'), 'Ready', 'binary and malformed output are not title facts');
  assert.equal(getObservedTerminalTitle('query-is-not-authority'), undefined);
  assert.deepEqual(first.upstream.input, [], 'observing the replay sends no input or resize');
  assert.equal(upstreams.length, 1, 'one upstream for the one browser');

  const clientFrame = Buffer.from('{"type":"input","data":"fixture only\\r"}');
  first.browser.send(clientFrame, { binary: false });
  await until(() => first.upstream.input.length === 1);
  assert.deepEqual(first.upstream.input, [{ data: clientFrame, binary: false }]);

  const second = await connect('id=relay-live');
  second.upstream.ws.send(JSON.stringify({ type: 'attached', id: 'relay-live' }));
  second.upstream.ws.send(JSON.stringify({ type: 'data', data: '\x1b]0;Working\x07' }));
  await until(() => second.output.length === 2);
  assert.equal(getObservedTerminalTitle('relay-live'), 'Ready', 'another viewer replay cannot override the oldest live stream');
  first.browser.close();
  await until(() => getObservedTerminalTitle('relay-live') === 'Working');
  assert.equal(second.upstream.ws.readyState, WebSocket.OPEN, 'remaining viewer is not closed');
  assert.deepEqual(second.upstream.input, []);
  second.upstream.ws.send(JSON.stringify({ type: 'exit', exitCode: 0 }));
  await until(() => getObservedTerminalTitle('relay-live') === undefined);
  second.browser.close();

  const params = new URLSearchParams({ initialCommand: 'codex --resume', cwd: 'C:/fixture' });
  const serverless = await connect(params.toString());
  assert.equal(new URL(serverless.upstream.url, base).searchParams.get('initialCommand'), 'codex --config "tui.terminal_title=[\'status\']" --resume');
  serverless.upstream.ws.send(JSON.stringify({ type: 'attached', id: 'relay-serverless', replayed: false }));
  serverless.upstream.ws.send(JSON.stringify({ type: 'data', data: '\x1b]2;Ready\x1b\\' }));
  await until(() => getObservedTerminalTitle('relay-serverless') === 'Ready');
  assert.deepEqual(serverless.upstream.input, []);
  serverless.upstream.ws.terminate();
  await until(() => getObservedTerminalTitle('relay-serverless') === undefined);

  const errored = await connect('id=relay-error');
  errored.upstream.ws.send(JSON.stringify({ type: 'attached', id: 'relay-error' }));
  errored.upstream.ws.send(JSON.stringify({ type: 'data', data: '\x1b]0;Working\x07' }));
  await until(() => getObservedTerminalTitle('relay-error') === 'Working');
  relaySockets[3].emit('error', new Error('owned fixture client socket error'));
  assert.equal(getObservedTerminalTitle('relay-error'), undefined, 'client error releases facts before the close handshake');
  await until(() => errored.upstream.ws.readyState === WebSocket.CLOSED);
  assert.deepEqual(errored.upstream.input, [], 'error cleanup sends no PTY command');
  assert.equal(upstreams.length, 4, 'observers never create their own upstream sockets');
});
