import { asJson, postJson } from './http';
import type { FindingDisposition, RecommendationSelection, SecurityApplyPreview, SecurityReview } from './types/opengrep';
export async function fetchSecurityReviews(project: string, signal?: AbortSignal) {
  return asJson<SecurityReview[]>(await fetch(`/api/opengrep/reviews?${new URLSearchParams({ project })}`, { signal }));
}
export function startSecurityReview(project: string, scanId: string, findingIds: string[], harness: string, piModel?: string) {
  return postJson<{ id: string; serverId: string; terminalId: string }>('/api/opengrep/reviews', { project, scanId, findingIds, harness, piModel });
}
export function cancelSecurityReview(project: string, id: string) {
  return postJson<{ cancelled: boolean }>(`/api/opengrep/reviews/${encodeURIComponent(id)}/cancel`, { project });
}
export function applySecurityRecommendations(project: string, id: string, selections: RecommendationSelection[], preview: boolean) {
  return postJson<SecurityApplyPreview>(`/api/opengrep/reviews/${encodeURIComponent(id)}/apply`, { project, selections, preview });
}
export function triageSecurityFinding(project: string, scanId: string, findingId: string, input: Partial<FindingDisposition>) {
  return postJson<FindingDisposition>('/api/opengrep/triage', { project, scanId, findingId, ...input });
}
export function shareSecurityIgnore(project: string, scanId: string, findingId: string, reason: string) {
  return postJson<{ taskId: string }>('/api/opengrep/shared-ignore', { project, scanId, findingId, reason });
}
export async function fetchSecurityTriageHistory(project: string, findingId: string, signal?: AbortSignal) {
  return asJson<{ history: (FindingDisposition & { fingerprint: string; path: string; ruleId: string })[] }>(await fetch(`/api/opengrep/triage?${new URLSearchParams({ project, findingId })}`, { signal }));
}
