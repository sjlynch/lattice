import { useEffect, useState } from 'react';
import { ExternalLink, MapPin, X } from 'lucide-react';
import type { OpengrepFinding } from '../../api/opengrep';
import type { FindingDisposition } from '../../api/types/opengrep';
import { fetchSecurityTriageHistory, shareSecurityIgnore, triageSecurityFinding } from '../../api/opengrepReview';
import { findingEditorUrl } from './securityFindings';
import type { useSecurityFindings } from './hooks/useSecurityFindings';

export function SecurityFindingDetail({ finding: f, project, scanId, onFocusFile, onClose, controller, fresh }: {
  finding: OpengrepFinding; project: string; scanId: string;
  onFocusFile: (path: string) => void; onClose: () => void; controller: ReturnType<typeof useSecurityFindings>; fresh: boolean;
}) {
  const [mode, setMode] = useState<'ignored' | 'deferred' | null>(null);
  const [scope, setScope] = useState('local');
  const [reason, setReason] = useState('');
  const [owner, setOwner] = useState('');
  const [reviewAt, setReviewAt] = useState('');
  const [history, setHistory] = useState<FindingDisposition[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => { setMode(null); setReason(''); setScope('local'); setOwner(''); setReviewAt(''); }, [f.fingerprint]);
  useEffect(() => {
    const controller = new AbortController();
    setHistory([]); setHistoryError(null);
    void fetchSecurityTriageHistory(project, f.fingerprint, controller.signal).then((data) => { if (!controller.signal.aborted) setHistory(data.history); }).catch((err: unknown) => { if (!controller.signal.aborted) setHistoryError(err instanceof Error ? err.message : String(err)); });
    return () => controller.abort();
  }, [project, f.fingerprint, f.triage?.updatedAt]);
  const save = async () => {
    if (!mode) return;
    const result = await controller.act<FindingDisposition | { taskId: string }>(() => scope === 'shared' && mode === 'ignored'
      ? shareSecurityIgnore(project, scanId, f.fingerprint, reason)
      : triageSecurityFinding(project, scanId, f.fingerprint, { status: mode, reason, owner, reviewAt: reviewAt || undefined }),
    scope === 'shared' && mode === 'ignored' ? 'Shared suppression task created. Review and run it on the task board.' : 'Finding disposition saved.');
    if (result) setMode(null);
  };
  return <aside className="security-detail-pane" aria-label="Finding details">
    <header><strong>{f.path}:{f.line}</strong><button className="icon-btn sm" aria-label="Close finding details" onClick={onClose}><X size={14} /></button></header>
    <p>{f.message}</p><code className="security-finding-rule">{f.ruleId}</code>
    <small>{f.category ?? 'Uncategorized'}{f.cwe.length ? ` · ${f.cwe.join(', ')}` : ''}</small>
    {f.snippet && <pre><code>{f.snippet}</code></pre>}
    <div className="security-finding-actions">
      <a href={findingEditorUrl(project, f)}><ExternalLink size={12} /> Open file at line {f.line}</a>
      <button onClick={() => onFocusFile(f.path)}><MapPin size={12} /> Show in graph</button>
      <button onClick={() => void controller.act(async () => { await navigator.clipboard.writeText(`${project}/${f.path}:${f.line}`); }, 'Location copied.')}>Copy location</button>
    </div>
    {f.references.filter((url) => /^https?:\/\//i.test(url)).map((url) => <a className="security-finding-reference" key={url} href={url} target="_blank" rel="noreferrer">{url}</a>)}
    {f.triage?.reason && <div className="security-disposition"><strong>{f.triage.expired ? 'Exception expired · reopened' : `${f.triage.status} · ${f.triage.scope}`}</strong><p>{f.triage.reason}</p>{f.triage.owner && <small>Owner: {f.triage.owner}</small>}{f.triage.reviewAt && <small>Review: {new Date(f.triage.reviewAt).toLocaleDateString()}</small>}</div>}
    {f.triage?.scope && f.triage.scope !== 'local' ? <p className="security-panel-notice">Managed in {f.triage.scope === 'settings' ? 'Settings → Tools. Remove the matching rule/fingerprint ignore there to reopen.' : 'source. Remove the rule-specific suppression in code and rescan to reopen.'}</p> : <div className="security-panel-actions security-detail-actions">
      {(f.triage?.status ?? 'open') === 'open' ? <><button disabled={controller.busy} onClick={() => setMode('ignored')}>Ignore…</button><button disabled={controller.busy} onClick={() => setMode('deferred')}>Defer / accept risk…</button></> : <button disabled={controller.busy} onClick={() => void controller.act(() => triageSecurityFinding(project, scanId, f.fingerprint, { status: 'open', reason: 'Reopened by user' }), 'Finding reopened.')}>Undo / reopen</button>}
    </div>}
    {mode && <form className="security-triage-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <strong>{mode === 'ignored' ? 'Ignore this occurrence' : 'Defer / accept this risk'}</strong>
      {mode === 'ignored' && <label>Scope<select aria-label="Ignore scope" value={scope} onChange={(e) => setScope(e.target.value)}><option value="local">Local to Lattice</option><option value="shared">Shared with repository / CI</option></select></label>}
      <small>{mode === 'ignored' && scope === 'shared' ? 'Creates a task to verify and add a rule-specific source suppression. CI picks it up after the change is reviewed and merged.' : 'Saved in Lattice on this machine. CI results are unchanged.'}</small>
      <label>Reason<textarea aria-label="Disposition reason" required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Evidence this is a false positive, or why the risk must be deferred" /></label>
      {mode === 'deferred' && <label>Owner<input aria-label="Risk owner" required value={owner} onChange={(e) => setOwner(e.target.value)} /></label>}
      {scope !== 'shared' && <label>Review date{mode === 'ignored' ? ' (optional)' : ''}<input type="date" aria-label="Risk review date" required={mode === 'deferred'} value={reviewAt} onChange={(e) => setReviewAt(e.target.value)} /></label>}
      <small>{reviewAt && scope !== 'shared' ? 'Reopens automatically on this date.' : ''}</small>
      <div><button className="btn-primary" disabled={controller.busy || scope === 'shared' && !fresh}>{scope === 'shared' ? 'Create suppression task' : 'Save'}</button><button type="button" onClick={() => setMode(null)}>Cancel</button></div>
    </form>}
    <details className="security-triage-history"><summary>Disposition history ({history.length})</summary>{historyError && <p role="alert">{historyError}</p>}{history.map((e, i) => <p key={i}><strong>{e.status}</strong> · {new Date(e.updatedAt).toLocaleString()}<br />{e.reason}{e.owner ? ` · ${e.owner}` : ''}</p>)}</details>
  </aside>;
}
