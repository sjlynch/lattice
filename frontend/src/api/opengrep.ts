// Opengrep (SAST) integration — engine status / install, rule packs, and
// project scans. Backend: src/routes/opengrep.ts over src/opengrep/.

import { asJson, deleteJson, postJson } from './http';
import type {
  OpengrepGraphResult,
  OpengrepInstallJob,
  OpengrepRulePackStatus,
  OpengrepScanEnvelope,
  OpengrepStatus,
} from './types/opengrep';

export type {
  OpengrepInstallJob,
  OpengrepRulePackJob,
  OpengrepRulePackStatus,
  OpengrepScanRecord,
  OpengrepStatus,
  OpengrepScanEnvelope,
  OpengrepGraphFile,
  OpengrepGraphResult,
  OpengrepFinding,
} from './types/opengrep';

const OPENGREP_GRAPH_SCAN_POLL_INTERVAL_MS = 1500;

// Called only by the Security chip. A long scan hands back its id, then GETs
// poll that exact scan; neither polling nor a failed request re-POSTs a scan.
export async function runOpengrepGraphScan(
  project: string,
  signal: AbortSignal,
  onAccepted?: (scan: { id: string; startedAt?: number }) => void,
  mode: 'full' | 'incremental' = 'full',
): Promise<OpengrepGraphResult> {
  const started = await asJson<OpengrepScanEnvelope | { scanId: string; status: 'running'; startedAt?: number }>(
    await fetch('/api/opengrep/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, async: true, acceptImmediately: true, mode }),
      signal,
    }),
  );
  const id = 'scanId' in started ? started.scanId : started.scan.id;
  onAccepted?.({ id, startedAt: 'scanId' in started ? started.startedAt : started.scan.startedAt });
  return waitForOpengrepGraphScan(project, id, signal);
}

export async function fetchOpengrepGraphResult(project: string, id = 'latest', signal?: AbortSignal): Promise<OpengrepGraphResult> {
  return asJson<OpengrepGraphResult>(await fetch(`/api/opengrep/scans/${encodeURIComponent(id)}?${new URLSearchParams({ project, format: 'graph' })}`, { signal }));
}

export async function cancelOpengrepGraphScan(project: string, id: string, signal: AbortSignal) {
  return asJson<{ cancelled: boolean }>(await fetch(`/api/opengrep/scans/${encodeURIComponent(id)}/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }), signal,
  }));
}

// Attach to a scan that the backend already accepted, including after refresh.
// Only GETs are issued here; the scan can finish even if its original tab closed.
export async function waitForOpengrepGraphScan(
  project: string,
  id: string,
  signal: AbortSignal,
): Promise<OpengrepGraphResult> {
  const params = new URLSearchParams({ project, format: 'graph' });
  while (true) {
    signal.throwIfAborted();
    const response = await fetch(`/api/opengrep/scans/${encodeURIComponent(id)}?${params}`, { signal });
    if (response.status !== 202) return asJson<OpengrepGraphResult>(response);
    // The backend owns timeout/failure policy. A running response must keep
    // the chip spinning and cancellable even after its estimated duration.
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, OPENGREP_GRAPH_SCAN_POLL_INTERVAL_MS);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

const statusListeners = new Set<(status: OpengrepStatus) => void>();
let statusRequestSequence = 0;

// Settings' installation polling also updates availability in the graph.
export function subscribeOpengrepStatus(listener: (status: OpengrepStatus) => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

export async function fetchOpengrepStatus(project?: string, signal?: AbortSignal): Promise<OpengrepStatus> {
  const sequence = ++statusRequestSequence;
  const q = project ? `?project=${encodeURIComponent(project)}` : '';
  const status = await asJson<OpengrepStatus>(await fetch(`/api/opengrep/status${q}`, { signal }));
  // A status request started before an installation refresh must not publish
  // its older answer after that refresh. Callers still get their own response.
  if (sequence === statusRequestSequence && !signal?.aborted) {
    for (const listener of statusListeners) listener(status);
  }
  return status;
}

export async function startOpengrepInstall(): Promise<{ job: OpengrepInstallJob }> {
  return postJson<{ job: OpengrepInstallJob }>('/api/opengrep/install');
}

export async function installOpengrepRulePack(
  packId: string,
): Promise<{ packs: OpengrepRulePackStatus[] }> {
  return postJson<{ packs: OpengrepRulePackStatus[] }>('/api/opengrep/rules/install', { packId });
}

export async function removeOpengrepRulePack(
  packId: string,
): Promise<{ packs: OpengrepRulePackStatus[] }> {
  return deleteJson<{ packs: OpengrepRulePackStatus[] }>(
    `/api/opengrep/rules/${encodeURIComponent(packId)}`,
  );
}

// Runs a scan with the project's configured packs + filter. Throws an
// `HttpError` with `.code` `busy` / `not-installed` / `no-rules` on a 409.
export async function runOpengrepScan(
  project: string,
  opts: { targets?: string[]; includeMarkdown?: boolean } = {},
): Promise<OpengrepScanEnvelope> {
  return postJson<OpengrepScanEnvelope>('/api/opengrep/scan', { project, ...opts });
}

