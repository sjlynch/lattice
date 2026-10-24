import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { OpengrepFinding } from '../../api/opengrep';
import { SECURITY_COLORS } from './securityOverlay';
export const SECURITY_ROW_HEIGHT = 72;
export function securityVisibleRange(count: number, top: number, height: number) {
  const start = Math.max(0, Math.min(count, Math.floor(top / SECURITY_ROW_HEIGHT) - 5));
  const end = Math.min(count, Math.ceil((top + height) / SECURITY_ROW_HEIGHT) + 5);
  return { start, end };
}
export function SecurityFindingList({ findings, selected, focused, onSelect, onFocus, badge, canSelect }: {
  findings: OpengrepFinding[]; selected: ReadonlySet<string>; focused?: string;
  onSelect: (f: OpengrepFinding, checked: boolean) => void; onFocus: (f: OpengrepFinding) => void;
  badge?: (f: OpengrepFinding) => ReactNode;
  canSelect?: (f: OpengrepFinding) => boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 400 });
  const identities = findings.map((f) => f.fingerprint).join('\0');
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight });
    // The element's own window's observer: the Security panel can be popped out.
    const Observer = element.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver;
    const observer = new Observer(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0;
    setViewport((v) => ({ ...v, top: 0 }));
  }, [identities]);
  const { start, end } = securityVisibleRange(findings.length, viewport.top, viewport.height);
  return <div className="security-finding-list" ref={scroller} role="list" aria-label="Findings" onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
    {!findings.length && <p className="security-panel-empty">No findings match these filters.</p>}
    <div style={{ height: start * SECURITY_ROW_HEIGHT }} aria-hidden="true" />
    {findings.slice(start, end).map((f, index) => <div className={`security-finding-row${focused === f.fingerprint ? ' is-selected' : ''}`} key={f.fingerprint} role="listitem" aria-posinset={start + index + 1} aria-setsize={findings.length}>
      <input type="checkbox" aria-label={`Select ${f.path}:${f.line}`} disabled={canSelect && !canSelect(f)} checked={selected.has(f.fingerprint)} onChange={(e) => onSelect(f, e.target.checked)} />
      <button className="security-finding-row-main" onClick={() => onFocus(f)} aria-expanded={focused === f.fingerprint} title={`${f.message}\n${f.ruleId}`}>
        <span className="security-finding-row-heading"><strong style={{ color: SECURITY_COLORS[f.severity] }}>{f.severity}</strong><span>{f.message}</span></span>
        <code>{f.path}:{f.line}</code><small>{f.ruleId}</small>
      </button>
      <div className="security-finding-row-badge">{badge?.(f) ?? (f.triage?.status !== 'open' ? f.triage?.status : '')}</div>
    </div>)}
    <div style={{ height: (findings.length - end) * SECURITY_ROW_HEIGHT }} aria-hidden="true" />
  </div>;
}
