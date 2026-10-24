import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge, RefreshCw } from 'lucide-react';
import { getPlanUsage, patchGlobalSettings, type PlanUsageReport } from '../api';
import { useDismissOnOutside } from '../hooks/useDismissOnOutside';
import { chipParts, chipTitle, guardChoices, guardHeldText, normalizePlanUsageReport, PROVIDER_LABEL, resetText, staleText, usageTone } from './planUsageDerive';

// Claude and Codex subscription usage in the navbar: the most-used window per
// provider on the chip, every window with its reset time in the popover.
// Polled every 5 min while the page is visible (the backend caches for 60 s,
// so tabs and agents share one provider read); opening the popover asks for
// fresh numbers. The footer sets the plan guard (globalSettings
// .planGuardPercent): new Claude / Codex task runs and workflow steps wait
// while a plan is past it.
const POLL_MS = 5 * 60_000;

export function PlanUsageChip() {
  const [report, setReport] = useState<PlanUsageReport | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [guardError, setGuardError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutside(open, ref, () => setOpen(false));

  const load = useCallback((refresh: boolean) => {
    if (document.hidden && !refresh) return;
    setLoading(true);
    getPlanUsage(refresh)
      .then((raw) => {
        const r = normalizePlanUsageReport(raw);
        if (!r) return;
        setReport(r);
        setNow(Date.now());
      })
      // A backend mid-restart (or one that predates the route): keep what we had.
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(false);
    const timer = window.setInterval(() => load(false), POLL_MS);
    const onVisible = () => load(false);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const setGuard = (percent: number) => {
    setGuardError(null);
    patchGlobalSettings({ planGuardPercent: percent })
      .then(() => load(true))
      .catch((err: unknown) => setGuardError(err instanceof Error ? err.message : String(err)));
  };

  const parts = chipParts(report);
  if (!parts.length) return null;
  const held = guardHeldText(report?.guard);
  return (
    <div className="appbar-usage" ref={ref}>
      <button
        className="appbar-usage-chip"
        title={held ? `${chipTitle(report)}
${held}` : chipTitle(report)}
        aria-label="Plan usage"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) load(true);
          setOpen((v) => !v);
        }}
      >
        <Gauge size={12} className="appbar-usage-icon" />
        {parts.map((p) => (
          <span key={p.provider} className="appbar-usage-part">
            <span className="appbar-usage-name">{p.label}</span>
            <span className={`appbar-usage-pct tone-${p.tone}`}>{p.text}</span>
          </span>
        ))}
      </button>
      {open && report && (
        <div className="popover appbar-usage-pop" role="dialog" aria-label="Plan usage">
          <div className="appbar-usage-pop-head">
            <span>Plan usage</span>
            <button className="icon-btn sm" onClick={() => load(true)} title="Refresh" aria-label="Refresh plan usage" disabled={loading}>
              <RefreshCw size={12} className={loading ? 'appbar-usage-spin' : undefined} />
            </button>
          </div>
          {report.providers.map((p) => {
            const stale = staleText(p.asOf, now);
            return (
              <section key={p.provider} className="appbar-usage-provider">
                <div className="appbar-usage-provider-head">
                  <strong>{PROVIDER_LABEL[p.provider]}</strong>
                  {p.plan && <span className="appbar-usage-plan">{p.plan}</span>}
                </div>
                {p.status !== 'ok' && <div className="appbar-usage-msg">{p.message ?? 'Unavailable'}</div>}
                {p.windows.map((w) => (
                  <div key={w.id} className="appbar-usage-window">
                    <div className="appbar-usage-window-row">
                      <span>{w.label}</span>
                      <span className={`appbar-usage-pct tone-${usageTone(w.usedPercent)}`}>{Math.round(w.usedPercent)}% used</span>
                    </div>
                    <div className="appbar-usage-bar" aria-hidden="true">
                      <span className={`tone-${usageTone(w.usedPercent)}`} style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} />
                    </div>
                    {w.resetsAt && <div className="appbar-usage-reset">{resetText(w.resetsAt, now)}</div>}
                  </div>
                ))}
                {p.notes.map((n) => (
                  <div key={n} className="appbar-usage-note">{n}</div>
                ))}
                <div className="appbar-usage-source">
                  {p.source}
                  {stale ? ` · ${stale}` : ''}
                </div>
              </section>
            );
          })}
          {report.guard && (
            <section className="appbar-usage-guard">
              <label className="appbar-usage-guard-row">
                <span>Plan guard</span>
                <select
                  className="text-input"
                  value={report.guard.percent ?? 0}
                  onChange={(e) => setGuard(Number(e.target.value))}
                  aria-label="Plan guard threshold"
                >
                  {guardChoices(report.guard.percent).map((p) => (
                    <option key={p} value={p}>{p === 0 ? 'Off' : `at ${p}%`}</option>
                  ))}
                </select>
              </label>
              <div className="appbar-usage-note">
                New Claude / Codex task runs and workflow steps wait while that plan is past this, until it resets. Pi, merges and your own terminals are never held.
              </div>
              {held && <div className="appbar-usage-guard-held">{held}</div>}
              {guardError && <div className="error-msg">{guardError}</div>}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
