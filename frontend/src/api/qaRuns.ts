// QA e2e-run helpers: kick off a Playwright-enabled Claude session that
// exercises one merged QA-lane task end-to-end, and poll for completion so the
// UI can auto-close the terminal once Claude's Stop hook has fired on the
// backend. Mirrors pushRuns.ts.

import { asJson } from './http';
import type { QaRunStatus, StartQaRunResult } from './types';
export type { QaRunStatus, StartQaRunResult } from './types';

export async function startQaRun(
  projectPath: string,
  taskId: string,
): Promise<StartQaRunResult> {
  return asJson<StartQaRunResult>(
    await fetch('/api/qa-runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: projectPath, taskId }),
    }),
  );
}

export async function fetchQaRunStatus(
  id: string,
): Promise<{ status: QaRunStatus; autoCloseTerminal?: boolean } | null> {
  const r = await fetch(`/api/qa-runs/${encodeURIComponent(id)}`);
  if (r.status === 404) return null;
  return asJson<{ status: QaRunStatus; autoCloseTerminal?: boolean }>(r);
}

export async function forgetQaRun(id: string): Promise<void> {
  await fetch(`/api/qa-runs/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(
    () => {},
  );
}
