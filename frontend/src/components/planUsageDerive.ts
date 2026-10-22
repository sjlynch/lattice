// Pure copy and derivation for the navbar plan-usage chip (PlanUsageChip):
// which number the chip shows per provider, its tone, and the reset wording.

import type { PlanUsageProvider, PlanUsageReport, PlanUsageWindow } from '../api';

export type UsageTone = 'ok' | 'warn' | 'high' | 'muted';

export const PROVIDER_LABEL: Record<PlanUsageProvider['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
};

// ≥ 90 % used → high, ≥ 70 % → warn.
export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 90) return 'high';
  if (usedPercent >= 70) return 'warn';
  return 'ok';
}

// The window that binds first: the most-used one (ties → the one resetting
// later, since it stays binding longer).
export function bindingWindow(p: PlanUsageProvider): PlanUsageWindow | null {
  let best: PlanUsageWindow | null = null;
  for (const w of p.windows) {
    if (!best || w.usedPercent > best.usedPercent || (w.usedPercent === best.usedPercent && (w.resetsAt ?? '') > (best.resetsAt ?? ''))) best = w;
  }
  return best;
}

export type ChipPart = { provider: PlanUsageProvider['provider']; label: string; text: string; tone: UsageTone };

// One compact part per provider, e.g. {Claude, "13%"}; a provider without
// numbers shows "—" (muted) so the chip never hides that it couldn't read it.
export function chipParts(report: PlanUsageReport | null): ChipPart[] {
  if (!report) return [];
  return report.providers.map((p) => {
    const w = p.status === 'ok' ? bindingWindow(p) : null;
    return w
      ? { provider: p.provider, label: PROVIDER_LABEL[p.provider], text: `${Math.round(w.usedPercent)}%`, tone: usageTone(w.usedPercent) }
      : { provider: p.provider, label: PROVIDER_LABEL[p.provider], text: '—', tone: 'muted' };
  });
}

// "resets in 42 min" / "resets in 3 h 5 min" / "resets Thu 18:00" (> 24 h).
export function resetText(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return '';
  const t = Date.parse(resetsAt);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((t - now) / 60_000);
  if (mins <= 0) return 'resets now';
  if (mins < 60) return `resets in ${mins} min`;
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `resets in ${h} h${m ? ` ${m} min` : ''}`;
  }
  const d = new Date(t);
  const day = d.toLocaleDateString('en-US', { weekday: 'short' });
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `resets ${day} ${hh}:${mm}`;
}

// "as of 3 min ago" for a snapshot older than 2 minutes, else ''.
export function staleText(asOf: string, now: number): string {
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return '';
  const mins = Math.round((now - t) / 60_000);
  if (mins < 2) return '';
  if (mins < 60) return `as of ${mins} min ago`;
  if (mins < 48 * 60) return `as of ${Math.round(mins / 60)} h ago`;
  return `as of ${Math.round(mins / (24 * 60))} days ago`;
}

export function chipTitle(report: PlanUsageReport | null): string {
  if (!report) return 'Plan usage';
  return report.providers
    .map((p) => {
      const w = p.status === 'ok' ? bindingWindow(p) : null;
      return `${PROVIDER_LABEL[p.provider]}: ${w ? `${Math.round(w.usedPercent)}% of the ${w.label.toLowerCase()} limit used` : (p.message ?? 'unavailable')}`;
    })
    .join('\n');
}
