import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Shield } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import type { OpengrepFinding } from '../../api/opengrep';
import type { SecurityOverlayControl } from './hooks/useSecurityOverlay';
import { useSecurityFindings } from './hooks/useSecurityFindings';
import { DEFAULT_SECURITY_FILTER, groupSecurityFindings, matchesSecurityFinding, passesSecurityFloor, securityFreshnessLabel } from './securityFindings';
import { SecurityFindingList } from './SecurityFindingList';
import { SecurityFindingDetail } from './SecurityFindingDetail';
import { SecurityReviewControls } from './SecurityReviewControls';

type Props = { security: SecurityOverlayControl; onFocusFile: (path: string) => void };
export function SecurityFindingsPanel({ security, onFocusFile }: Props) {
  const result = security.result;
  const project = result?.canonicalProject ?? '';
  const controller = useSecurityFindings(project, security.onRefresh);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'open' | 'ignored' | 'deferred' | 'all'>('open');
  const [groupBy, setGroupBy] = useState<'file' | 'rule'>('file');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [showBelowFloor, setShowBelowFloor] = useState(false);
  const filter = security.filter ?? DEFAULT_SECURITY_FILTER;
  const all = result?.allFindings ?? result?.findings ?? [];
  const inventory = useMemo(() => all.filter((f) => showBelowFloor || filter.severity !== 'all' || passesSecurityFloor(f, result?.filter?.severityFloor)), [all, showBelowFloor, filter.severity, result?.filter?.severityFloor]);
  const matches = useMemo(() => {
    const filtered = inventory.filter((f) => matchesSecurityFinding(f, filter, query, status, security.panelFile));
    return groupSecurityFindings(filtered, groupBy).flatMap((group) => group.findings);
  }, [inventory, status, security.panelFile, filter, query, groupBy]);
  const scopes = {
    all: inventory.filter((f) => (f.triage?.status ?? 'open') === 'open').map((f) => f.fingerprint),
    filtered: matches.filter((f) => (f.triage?.status ?? 'open') === 'open').map((f) => f.fingerprint),
    selected: all.filter((f) => selected.has(f.fingerprint) && (f.triage?.status ?? 'open') === 'open').map((f) => f.fingerprint),
  };
  const focusedFinding = all.find((f) => f.fingerprint === focused);
  const select = (f: OpengrepFinding, checked: boolean) => {
    setSelected((old) => { const next = new Set(old); if (checked) next.add(f.fingerprint); else next.delete(f.fingerprint); return next; });
  };
  useEffect(() => { setQuery(''); setFocused(null); setSelected(new Set()); }, [project]);
  useEffect(() => { setFocused(null); }, [security.panelFile]);
  const fresh = result?.freshness?.state === 'current' && !security.scanning;
  return <FloatingPanel open={security.panelOpen === true} onClose={() => security.onCloseFindings?.()}
    title={<span className="security-panel-title"><Shield size={15} /> Scan findings</span>}
    defaultSize={{ width: Math.min(900, window.innerWidth - 32), height: Math.min(780, window.innerHeight - 36) }} minSize={{ width: 420, height: 380 }}
    defaultPosition={{ x: Math.max(12, window.innerWidth - 916), y: 18 }} storageKey="lattice.security.findings.window">
    <div className="security-panel">{result && <>
      <div className="security-panel-summary"><strong>{result.shown} shown findings</strong><span>{securityFreshnessLabel(result)}</span><small>Scanned {new Date(result.scan.finishedAt).toLocaleString()} · {(result.scan.durationMs / 1000).toFixed(1)}s{result.scan.update ? ` · ${result.scan.update.analyzedFiles} files analyzed · ${result.scan.update.reusedFiles} reused` : ''}</small>
        {security.scanning && <div role="status"><span className="spinner graph-security-spinner" /> Updating… Previous findings remain available.</div>}
      </div>
      <div className="security-panel-actions"><button className="btn-primary" disabled={security.scanning} onClick={() => void security.onScan?.('incremental')}><RefreshCw size={13} /> Update changed files</button><button className="btn-ghost" disabled={security.scanning} onClick={() => void security.onScan?.('full')}>Full scan</button>{security.scanning && <button disabled={security.cancelling} onClick={() => void security.onToggle()}>Cancel scan</button>}</div>
      {(security.error || controller.error) && <div className="security-panel-feedback error-msg" role="alert">{controller.error ?? security.error}</div>}
      {controller.notice && <div className="security-panel-feedback" role="status">{controller.notice}</div>}
      <SecurityReviewControls project={project} scanId={result.scan.id} fresh={fresh} controller={controller} scopes={scopes} onOpenConsole={() => security.onCloseFindings?.()} />
      <div className="security-panel-filters">
        <input className="text-input" aria-label="Search findings" placeholder="Search files, rules or messages…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label>Category<select aria-label="Category" value={filter.category} onChange={(e) => security.onFilterChange?.({ ...filter, category: e.target.value as typeof filter.category })}><option value="all">All findings</option><option value="security">Security</option><option value="quality">Code quality</option></select></label>
        <label>Severity<select aria-label="Severity" value={filter.severity} onChange={(e) => security.onFilterChange?.({ ...filter, severity: e.target.value as typeof filter.severity })}><option value="all">All severities</option><option value="ERROR">ERROR</option><option value="WARNING">WARNING</option><option value="INFO">INFO</option></select></label>
        <label>Sort by<select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}><option value="file">File</option><option value="rule">Rule</option></select></label>
        <label>Status<select aria-label="Finding status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>{(['open', 'ignored', 'deferred', 'all'] as const).map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : `${s[0].toUpperCase()}${s.slice(1)} (${inventory.filter((f) => (f.triage?.status ?? 'open') === s).length})`}</option>)}</select></label>
        {all.some((f) => !passesSecurityFloor(f, result.filter?.severityFloor)) && <label className="security-below-floor"><input aria-label="Include findings below Settings severity floor" type="checkbox" checked={showBelowFloor} onChange={(e) => setShowBelowFloor(e.target.checked)} />Include findings below Settings severity floor</label>}
      </div>
      {security.panelFile && <div className="security-panel-file"><span>{security.panelFile}</span><button onClick={() => security.onShowFindings?.()}>All files</button></div>}
      <div className={`security-panel-content${focusedFinding ? ' has-detail' : ''}`}>
        <SecurityFindingList findings={matches} selected={selected} focused={focused ?? undefined} onSelect={select} onFocus={(f) => { setFocused(f.fingerprint); onFocusFile(f.path); }} />
        {focusedFinding && <SecurityFindingDetail key={focusedFinding.fingerprint} finding={focusedFinding} project={project} scanId={result.scan.id} controller={controller} fresh={fresh} onFocusFile={onFocusFile} onClose={() => setFocused(null)} />}
      </div>
      <footer className="security-panel-footer"><span>{matches.length} matching · {all.length} total saved findings · {selected.size} selected</span>
        <div><button onClick={() => setSelected(new Set(matches.map((f) => f.fingerprint)))}>Select filtered</button><button onClick={() => setSelected(new Set())}>Clear selection</button></div>
        {(result.errors > 0 || result.partiallyParsed > 0 || result.skippedRules > 0) && <details className="security-scan-caveats"><summary>Coverage: {result.errors} errors · {result.partiallyParsed} partially parsed files · {result.skippedRules} skipped rules</summary>{result.caveats?.errors.map((e, i) => <p key={i}>{e.path}: {e.message}</p>)}{result.caveats?.partiallyParsed.map((path) => <p key={path}>{path}: partially parsed</p>)}</details>}
      </footer>
    </>}</div>
  </FloatingPanel>;
}
