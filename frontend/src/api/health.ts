// Live health-update subscription. The backend's /ws/health endpoint
// pushes a HealthUpdate per file save / tree change; the App applies
// metrics patches in place and only re-scans when the visible file tree
// changed.

import type { HealthUpdate } from './types';
import { subscribeWs } from './ws';

export function subscribeHealth(
  project: string,
  onUpdate: (event: HealthUpdate) => void,
): () => void {
  const url = `/ws/health?project=${encodeURIComponent(project)}`;
  return subscribeWs<HealthUpdate>(url, onUpdate);
}
