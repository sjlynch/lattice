import { useEffect, useState } from 'react';
import { SettingsInfo } from '../settings/SettingsInfo';
import { useHarnessAvailability } from '../../hooks/useHarnessAvailability';
import { usePiModelMenu } from '../../hooks/usePiModelMenu';
import { buildHarnessOptions, decodeHarnessValue, encodeHarnessValue, type AgentHarness } from '../../harnesses';
import { useTerminals } from '../../TerminalsContext';
import { cancelSecurityReview, startSecurityReview } from '../../api/opengrepReview';
import type { useSecurityFindings } from './hooks/useSecurityFindings';

export function SecurityReviewControls({ project, scanId, fresh, controller, scopes, onOpenConsole }: {
  project: string; scanId: string; fresh: boolean; controller: ReturnType<typeof useSecurityFindings>;
  scopes: { all: string[]; filtered: string[]; selected: string[] };
  onOpenConsole: () => void;
}) {
  const { harnessAvail, harnessAvailLoaded } = useHarnessAvailability();
  const piMenu = usePiModelMenu();
  const { setActiveId, terminals, restoreTabs } = useTerminals();
  const [harness, setHarness] = useState<AgentHarness>('claude');
  const [piModel, setPiModel] = useState<string | undefined>();
  const [scope, setScope] = useState<'all' | 'filtered' | 'selected'>(scopes.selected.length ? 'selected' : 'filtered');
  const [restoring, setRestoring] = useState(false);
  const [ending, setEnding] = useState(false);
  const active = controller.reviews.find((r) => r.status === 'running' || r.status === 'awaiting-decision');
  const latest = active ?? controller.reviews[0];
  const tab = terminals.find((t) => t.id === active?.terminalId);
  const selectionKey = scopes.selected.join(',');
  useEffect(() => {
    setScope((old) => selectionKey ? 'selected' : old === 'selected' ? 'filtered' : old);
  }, [selectionKey, project]);
  useEffect(() => { if (harnessAvailLoaded && !harnessAvail[harness]) setHarness(harnessAvail.codex ? 'codex' : harnessAvail.pi ? 'pi' : 'claude'); }, [harnessAvail, harnessAvailLoaded, harness]);
  const startDisabledReason = controller.busy ? 'Wait for the current action to finish.'
    : active ? 'A review is already open.'
    : !fresh ? 'The scan is out of date or updating. Click Update changed files above to enable review.'
    : !harnessAvailLoaded ? 'Checking installed coding harnesses…'
    : !harnessAvail[harness] ? 'Choose an installed coding harness.'
    : !scopes[scope].length ? 'Choose a scope containing at least one open finding.'
    : undefined;
  const shownHarness = active?.harness ?? harness;
  const shownPiModel = active?.piModel ?? piModel;
  const options = buildHarnessOptions({ harnessAvail, piMenu, selected: { harness: shownHarness, piModel: shownPiModel }, includeInterleave: false });
  const start = async () => {
    const value = await controller.act(() => startSecurityReview(project, scanId, scopes[scope], harness, piModel),
      'Review started in the console. The agent will recommend options and wait for your reply before creating tasks.');
    if (value) { setActiveId(value.terminalId); onOpenConsole(); }
  };
  const openConsole = async () => {
    if (!active?.terminalId) return;
    if (active.needsRestore || tab?.restore === 'failed' || tab?.status === 'dead') {
      setRestoring(true);
      try {
        await controller.act(() => restoreTabs({ retry: true }));
      } finally { setRestoring(false); }
    }
    setActiveId(active.terminalId);
    onOpenConsole();
  };
  const end = async (id: string) => {
    if (ending) return;
    setEnding(true);
    try {
      await controller.act(() => cancelSecurityReview(project, id),
        'Review ended. Any tasks you agreed to create remain on the board.', true);
    } finally { setEnding(false); }
  };
  return <div className="security-review-controls">
    <div className="security-review-launch">
      <div className="security-review-config security-review-launch-row">
        <label>Harness<select aria-label="Review harness" disabled={!!active || controller.busy} value={encodeHarnessValue(shownHarness, shownPiModel)} onChange={(e) => { const value = decodeHarnessValue(e.target.value); if (value.harness !== 'interleave') { setHarness(value.harness); setPiModel(value.piModel); } }}>{options.map((o) => <option key={o.value} value={o.value} title={o.title}>{o.label}</option>)}</select></label>
        <label>Scope<select aria-label="Review scope" disabled={!!active || controller.busy} value={active ? 'active' : scope} onChange={(e) => setScope(e.target.value as typeof scope)}>{active && <option value="active">{active.findingCount} reviewed finding{active.findingCount === 1 ? '' : 's'}</option>}<option value="filtered">Filtered open ({scopes.filtered.length})</option><option value="all">All open ({scopes.all.length})</option><option value="selected">Selected open ({scopes.selected.length})</option></select></label>
        {active
          ? <button disabled={ending} onClick={() => void end(active.id)}>{ending ? 'Ending…' : 'End review'}</button>
          : <span className="security-review-start" title={startDisabledReason}><button className="btn-primary" disabled={!!startDisabledReason} onClick={() => void start()}>Start review ({scopes[scope].length})</button></span>}
        <SettingsInfo label="About findings review">
          <p>Discuss these findings with the coding harness in its console. It explains its recommendations and offers choices, then waits for your reply.</p>
          <p>Agreed tasks appear in Open on the Lattice board for you to review and run. Starting a review does not change code or create tasks.</p>
          <p>Open console returns to the conversation after a refresh. Advice stays in that conversation; Lattice stores only session status. End review closes the console.</p>
          <p>A current scan is required to start. Update changed files after editing code or rules.</p>
        </SettingsInfo>
      </div>
      {!fresh && !active && <small className="security-review-disabled-hint">{startDisabledReason}</small>}
    </div>
    {active && <div className="security-review-session">
      <span role="status">{active.status === 'running' && <span className="spinner graph-security-spinner" />}
        {!active.terminalId ? 'Waiting for a console…' : active.restoring ? 'Restoring review console…'
          : active.status === 'awaiting-decision' ? `Awaiting your decision in ${active.harness}.`
          : `Reviewing ${active.findingCount} finding${active.findingCount === 1 ? '' : 's'} in ${active.harness}…`}</span>
      {active.terminalId && <button disabled={restoring || active.restoring || active.consoleAvailable === false} onClick={() => void openConsole()}>{active.needsRestore || tab?.restore === 'failed' || tab?.status === 'dead' ? 'Restore console' : 'Open console'}</button>}
    </div>}
    {latest?.error && <div className="security-review-session">
      <p className="error-msg" role="alert">{latest.error}</p>
      {latest.status === 'cancelled' && <button disabled={controller.busy || ending} onClick={() => void end(latest.id)}>Retry ending review</button>}
    </div>}
  </div>;
}
