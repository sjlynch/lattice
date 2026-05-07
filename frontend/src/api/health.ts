// Live health-update subscription. The backend's /ws/health endpoint
// pushes a HealthUpdate per file save; the App applies it to the
// current scan result so the graph reflects the new score without a
// full re-scan.

import type { HealthUpdate } from './types';
import { subscribeWs } from './ws';

export function subscribeHealth(
  project: string,
  onUpdate: (event: HealthUpdate) => void,
): () => void {
  const url = `/ws/health?project=${encodeURIComponent(project)}`;
  return subscribeWs<HealthUpdate>(url, onUpdate);
}
