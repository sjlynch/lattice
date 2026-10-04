import { useEffect, useState } from 'react';
import { SettingsInfo } from '../settings/SettingsInfo';
import { useHarnessAvailability } from '../../hooks/useHarnessAvailability';
import { usePiModelMenu } from '../../hooks/usePiModelMenu';
import { buildHarnessOptions, decodeHarnessValue, encodeHarnessValue, type AgentHarness } from '../../harnesses';
import { useTerminals } from '../../TerminalsContext';
import type { SecurityReview, RecommendationSelection, SecurityApplyPreview } from '../../api/types/opengrep';
import { applySecurityRecommendations, cancelSecurityReview, startSecurityReview } from '../../api/opengrepReview';
import type { useSecurityFindings } from './hooks/useSecurityFindings';

export function SecurityReviewControls({ project, scanId, fresh, controller, scopes, review, onReviewChange, selected, onSelectFixes, onClear, onStarted }: {
  project: string; scanId: string; fresh: boolean; controller: ReturnType<typeof useSecurityFindings>;
  scopes: { all: string[]; filtered: string[]; selected: string[] }; review: SecurityReview | null;
  onReviewChange: (id: string) => void; selected: ReadonlySet<string>; onSelectFixes: () => void; onClear: () => void; onStarted: (id: string) => void;
}) {
  const { harnessAvail, harnessAvailLoaded } = useHarnessAvailability();
  const piMenu = usePiModelMenu();
  const { setActiveId } = useTerminals();
  const [harness, setHarness] = useState<AgentHarness>('claude');
  const [piModel, setPiModel] = useState<string | undefined>();
  const [scope, setScope] = useState<'all' | 'filtered' | 'selected'>('filtered');
  const [ignoreScope, setIgnoreScope] = useState<'local' | 'shared'>('local');
  const [owner, setOwner] = useState('');
  const [reviewAt, setReviewAt] = useState('');
  const [preview, setPreview] = useState<{ data: SecurityApplyPreview; selections: RecommendationSelection[]; reviewId: string } | null>(null);
  const running = controller.reviews.find((r) => r.status === 'running');
  const startDisabledReason = controller.busy ? 'Wait for the current action to finish.'
    : running ? 'A review is already running.'
    : !fresh ? 'The scan is out of date or updating. Click Update changed files above to enable review.'
    : !harnessAvailLoaded ? 'Checking installed coding harnesses…'
    : !harnessAvail[harness] ? 'Choose an installed coding harness.'
    : !scopes[scope].length ? 'Choose a scope containing at least one open finding.'
    : undefined;
  const options = buildHarnessOptions({ harnessAvail, piMenu, selected: { harness, piModel }, includeInterleave: false });
  useEffect(() => { if (harnessAvailLoaded && !harnessAvail[harness]) setHarness(harnessAvail.codex ? 'codex' : harnessAvail.pi ? 'pi' : 'claude'); }, [harnessAvail, harnessAvailLoaded, harness]);
  useEffect(() => { setPreview(null); }, [review?.id]);
  const start = async () => {
    const value = await controller.act(() => startSecurityReview(project, scanId, scopes[scope], harness, piModel), 'Agent review started. Recommendations appear here when it finishes.');
    if (value) onStarted(value.id);
  };
  const deferred = review?.recommendations.some((r) => selected.has(r.findingId) && r.action === 'defer');
  const suppressions = review?.recommendations.some((r) => selected.has(r.findingId) && r.action === 'suppress');
  const prepare = async () => {
    if (!review) return;
    const selections = [...selected].map((findingId) => ({ findingId, scope: ignoreScope, owner: owner || undefined, reviewAt: reviewAt || undefined }));
    const data = await controller.act(() => applySecurityRecommendations(project, review.id, selections, true));
    if (data) setPreview({ data, selections, reviewId: review.id });
  };
  const apply = async () => {
    if (!preview) return;
    const result = await controller.act(() => applySecurityRecommendations(project, preview.reviewId, preview.selections, false), 'Selected recommendations applied. Created tasks are in Open on the task board.');
    if (result) { setPreview(null); onClear(); }
  };
  return <div className="security-review-controls">
    <div className="security-review-launch">
      <div className="security-review-config security-review-launch-row">
        <label>Harness<select aria-label="Review harness" value={encodeHarnessValue(harness, piModel)} onChange={(e) => { const value = decodeHarnessValue(e.target.value); if (value.harness !== 'interleave') { setHarness(value.harness); setPiModel(value.piModel); } }}>{options.map((o) => <option key={o.value} value={o.value} title={o.title}>{o.label}</option>)}</select></label>
        <label>Scope<select aria-label="Review scope" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="filtered">Filtered open ({scopes.filtered.length})</option><option value="all">All open ({scopes.all.length})</option><option value="selected">Selected open ({scopes.selected.length})</option></select></label>
        {running
          ? <button onClick={() => void controller.act(() => cancelSecurityReview(project, running.id), 'Agent review cancelled.', true)}>Cancel review</button>
          : <span className="security-review-start" title={startDisabledReason}><button className="btn-primary" disabled={!!startDisabledReason} onClick={() => void start()}>Start review</button></span>}
        <SettingsInfo label="About findings review">
          <p>Review source and produce recommendations. Fixes and shared suppressions become tasks after you select and apply them.</p>
          <p>A current scan is required, even when reviewing a single finding. Update changed files after editing code or rules.</p>
        </SettingsInfo>
      </div>
      {!fresh && !running && <small className="security-review-disabled-hint">{startDisabledReason}</small>}
    </div>
    {!!controller.reviews.length && <div className="security-review-report-header">
      <label>Review<select aria-label="Review report" value={review?.id ?? ''} onChange={(e) => onReviewChange(e.target.value)}>{controller.reviews.map((r) => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.harness} · {r.status}</option>)}</select></label>
      {review?.status === 'running' && <span role="status"><span className="spinner graph-security-spinner" /> Reviewing {review.findings.length} findings…</span>}
      {review?.terminalId && review.status === 'running' && <button onClick={() => setActiveId(review.terminalId!)}>Open agent terminal</button>}
      {review?.error && <p className="error-msg" role="alert">{review.error}</p>}
      {review?.status === 'done' && <>
        <small>{(['fix', 'suppress', 'defer', 'needs-review'] as const).map((action) => `${review.recommendations.filter((r) => r.action === action).length} ${action}`).join(' · ')}</small>
        <div className="security-review-bulk"><button disabled={controller.busy} onClick={onSelectFixes}>Select current fixes</button><button onClick={onClear}>Clear selection</button><button className="btn-primary" disabled={controller.busy || selected.size === 0} onClick={() => void prepare()}>Preview selected ({selected.size})</button></div>
        {suppressions && <label>Selected suppressions<select aria-label="Recommendation ignore scope" value={ignoreScope} onChange={(e) => setIgnoreScope(e.target.value as typeof ignoreScope)}><option value="local">Local ignores in Lattice</option><option value="shared">Propose shared suppression tasks</option></select></label>}
        {deferred && <div className="security-review-config"><label>Risk owner<input aria-label="Recommendations risk owner" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Owner (overrides agent suggestion)" /></label><label>Review date<input aria-label="Recommendations review date" type="date" value={reviewAt} onChange={(e) => setReviewAt(e.target.value)} /></label></div>}
      </>}
    </div>}
    {preview && <section className="security-apply-preview" aria-label="Apply recommendations preview">
      <strong>Apply selected recommendations</strong>
      <p>{preview.data.counts.fixes} fixes · {preview.data.counts.localIgnores} local ignores · {preview.data.counts.sharedIgnores} shared suppressions · {preview.data.counts.deferred} deferred</p>
      <p>{preview.data.tasks.length} tasks will be created in Open for review and execution. Local dispositions take effect now.</p>
      <div className="security-apply-tasks">{preview.data.tasks.map((t, i) => <details key={i}><summary>{t.title}</summary><pre>{t.description}</pre></details>)}</div>
      <div><button className="btn-primary" disabled={controller.busy} onClick={() => void apply()}>Apply selected</button><button disabled={controller.busy} onClick={() => setPreview(null)}>Back</button></div>
    </section>}
  </div>;
}
