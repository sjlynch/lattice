// Shared fixtures + the mounted chip/hook harness for the securityOverlay
// suites, split by behaviour across securityOverlay.{scan,restore,
// projectSwitch,availability,graph}.test.ts. They all pin one rule: Security
// must never POST from an effect, a project change, or a graph update — only an
// explicit click scans.
//
// `setup(t, status)` drives the real chip (GraphOverlayKey) + useSecurityOverlay
// against a fetch double with delayed HTTP, including out-of-scope results:
// status reads answer `setStatus` (null → held in `statusRequests` until the
// test resolves it), scan POSTs wait in `pending`, cancels and graph reads
// answer `setCancelReply` / `setGraphReply`. Every global it installs is
// restored in `t.after`.
import type { TestContext } from 'node:test';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ForceGraph3DInstance } from '3d-force-graph';
import type { OpengrepGraphResult } from '../api';
import type { OpengrepStatus } from '../api/opengrep.ts';
import { useSecurityOverlay } from '../components/forceGraph/hooks/useSecurityOverlay.ts';
import { GraphOverlayKey } from '../components/forceGraph/GraphOverlayKey.tsx';
import { installGlobal } from './domDoubles.ts';

export const result: OpengrepGraphResult = {
  canonicalProject: 'C:/projA',
  scan: { id: 'og_first', project: 'C:/projA', startedAt: 0, finishedAt: 1250, durationMs: 1250,
    engine: { version: '1.30.0', source: 'path' }, packIds: [], rulePaths: [], targets: ['C:/projA'],
    exitCode: 0, findings: 1, bySeverity: { ERROR: 1, WARNING: 0, INFO: 0 },
    scannedFiles: 2, errors: 0, partiallyParsed: 0, jsonFile: '' },
  files: [
    { path: 'src/a.ts', severity: 'ERROR', findings: 1, incomplete: false },
    { path: 'clean.json', severity: null, findings: 0, incomplete: false },
  ],
  shown: 1, errors: 0, partiallyParsed: 0, skippedRules: 0,
  findings: [{
    fingerprint: 'fp-a', shortFingerprint: 'fp-a', ruleId: 'rule.a', severity: 'ERROR', message: 'finding in a',
    path: 'src/a.ts', line: 1, endLine: 1, col: 1, snippet: '', cwe: [], references: [],
  }],
  allFindings: [],
  bySeverity: { ERROR: 1, WARNING: 0, INFO: 0 }, total: 1,
  dropped: { belowFloor: 0, ignoredRules: 0, ignoredFingerprints: 0, duplicates: 0 },
  filter: { severityFloor: 'INFO', ignoreRuleIds: [], ignoreFingerprints: [] },
  caveats: { errors: [], partiallyParsed: [] },
  freshness: { state: 'unknown', changedFiles: 0, configurationChanged: false, checkedAt: 0 },
};
result.allFindings = result.findings;
const noPins = { health: false, loc: false, dead: false, worktree: false, labels: false };
export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const installedStatus: OpengrepStatus = {
  available: true, engine: { command: 'opengrep', source: 'path', version: '1.30.0' },
  managedVersion: '1.30.0', managedInstalled: false, platformAsset: null, installJob: null, packs: [],
};

export async function setup(t: TestContext, status: OpengrepStatus | null = installedStatus) {
  const restoreReact = installGlobal('React', React);
  const restoreAct = installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const browserWindow = new EventTarget();
  const browserDocument = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const restoreWindow = installGlobal('window', browserWindow);
  const restoreDocument = installGlobal('document', browserDocument);
  const requests: { url: string; init?: RequestInit }[] = [];
  const statusReads: { url: string; init?: RequestInit }[] = [];
  const statusRequests: { init?: RequestInit; resolve: (response: Response) => void }[] = [];
  const pending: ((response: Response) => void)[] = [];
  let nextStatus = status;
  let graphReply: (url: string, init?: RequestInit) => Promise<Response> = async () => json(result);
  let cancelReply: () => Promise<Response> = async () => json({ cancelled: true });
  const restoreFetch = installGlobal('fetch', (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/opengrep/status')) {
      statusReads.push({ url, init });
      if (nextStatus) return Promise.resolve(json(nextStatus));
      return new Promise<Response>((resolve) => statusRequests.push({ init, resolve }));
    }
    requests.push({ url, init });
    if (url.endsWith('/cancel')) return cancelReply();
    if (url.includes('/scans/latest?')) return Promise.resolve(json({ ...result, scan: nextStatus?.project?.lastScan ?? result.scan }));
    if (init?.method === 'POST') return new Promise<Response>((resolve) => pending.push(resolve));
    return graphReply(url, init);
  });
  let refreshes = 0;
  const graph = { refresh: () => { refreshes++; }, enablePointerInteraction: () => graph } as unknown as ForceGraph3DInstance;
  const graphRef = { current: graph };
  let latest!: ReturnType<typeof useSecurityOverlay>;
  function Harness({ project }: { project: string }) {
    latest = useSecurityOverlay(project, graphRef);
    return React.createElement(GraphOverlayKey, { pinned: noPins, active: noPins,
      onTogglePin: () => {}, security: latest.security });
  }
  let renderer!: ReturnType<typeof TestRenderer.create>;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { project: 'C:/projA' })); });
  t.after(async () => {
    await act(async () => { renderer.unmount(); });
    restoreFetch(); restoreDocument(); restoreWindow(); restoreAct(); restoreReact();
  });
  return {
    requests, pending, get latest() { return latest; }, get refreshes() { return refreshes; },
    statusRequests, statusReads, browserWindow, browserDocument,
    setStatus: (next: OpengrepStatus | null) => { nextStatus = next; },
    setGraphReply: (reply: typeof graphReply) => { graphReply = reply; },
    setCancelReply: (reply: typeof cancelReply) => { cancelReply = reply; },
    chip: () => renderer.root.findAllByType('button').find((b) =>
      b.findAllByType('span').some((s) => s.children.includes('Security')))!,
    update: async (project: string) => { await act(async () => { renderer.update(React.createElement(Harness, { project })); }); },
    remount: async () => {
      await act(async () => { renderer.unmount(); });
      await act(async () => { renderer = TestRenderer.create(React.createElement(Harness, { project: 'C:/projA' })); });
    },
    get renderer() { return renderer; },
  };
}
