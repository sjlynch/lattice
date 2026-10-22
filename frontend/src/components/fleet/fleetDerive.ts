// Pure copy and derivation for the Fleet panel: lane summaries, relative
// times, the merged activity feed and which projects match a filter.

import type { FleetEvent, FleetHost, FleetProject, FleetTask } from '../../api';

// "2 running · 1 to merge · 1 QA · 5 open" — only non-zero lanes, in flow order.
export function laneSummary(lanes: Record<string, number>): string {
  const parts: string[] = [];
  const add = (n: number | undefined, label: string) => { if (n) parts.push(`${n} ${label}`); };
  add(lanes.in_progress, 'running');
  add(lanes.ready_to_merge, 'to merge');
  add(lanes.qa, 'QA');
  add(lanes.open, 'open');
  add(lanes.backlog, 'backlog');
  return parts.join(' · ') || 'no open tasks';
}

// "now" / "42 s" / "5 min" / "3 h" / "2 d" ago.
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export const FEED_CAP = 300;

// New events appended to the kept feed (deduped by seq, oldest dropped past
// the cap); returned newest-first for display by `feedNewestFirst`.
export function mergeFeed(kept: FleetEvent[], incoming: FleetEvent[], cap = FEED_CAP): FleetEvent[] {
  if (!incoming.length) return kept;
  const seen = new Set(kept.map((e) => e.seq));
  const merged = [...kept, ...incoming.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}

export function feedNewestFirst(feed: FleetEvent[]): FleetEvent[] {
  return [...feed].reverse();
}

// Case-insensitive match on project name / path, terminal labels and the
// titles of tasks in flight.
export function projectMatches(p: FleetProject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.name, p.path, ...p.terminals.map((t) => t.label), ...p.inProgress.map((t) => t.title), ...p.runs.map((r) => r.label)]
    .some((s) => s.toLowerCase().includes(q));
}

// Project basename for a feed line ("alpha"), from its canonical path.
export function projectName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

export function busyCount(p: FleetProject): number {
  return p.terminals.filter((t) => t.busy).length;
}

// The second opinion on a task waiting for review, as a short badge.
export function reviewBadge(t: FleetTask): { text: string; tone: 'ok' | 'warn' | 'muted' } | null {
  const r = t.review;
  if (!r) return null;
  const p = r.p !== undefined ? ` ${Math.round(r.p)}` : '';
  if (r.status === 'accepted') return { text: `accepted${p}`, tone: 'ok' };
  if (r.status === 'rejected') return { text: `doubtful${p}`, tone: 'warn' };
  if (r.status === 'reviewing') return { text: 'reviewing…', tone: 'muted' };
  if (r.status === 'rerun') return { text: 're-running', tone: 'muted' };
  return { text: 'review failed', tone: 'muted' };
}

// "Claude · Codex · Pi (ornith, qwen) · Claude 13% · Codex 0%" — what a PC can
// run and how much of each plan it has used.
export function hostSummary(h: FleetHost | undefined): string {
  if (!h) return '';
  const harnesses = (['claude', 'codex', 'pi'] as const).filter((x) => h.harnesses[x]);
  const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };
  const parts = harnesses.map((x) => (x === 'pi' && h.piModels.length ? `Pi (${h.piModels.slice(0, 4).join(', ')}${h.piModels.length > 4 ? ', …' : ''})` : names[x]));
  for (const p of h.plans) if (p.usedPercent !== undefined) parts.push(`${names[p.provider] ?? p.provider} ${Math.round(p.usedPercent)}%`);
  return parts.join(' · ');
}
