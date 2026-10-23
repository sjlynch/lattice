import { useState } from 'react';
import { FolderOpen, GitMerge, MessageSquarePlus } from 'lucide-react';
import { startFleetMergeRun, type FleetLaunchResult, type FleetProject, type FleetTerminal } from '../../api';
import { FleetReviewList } from './FleetReviewList';
import { harnessLabel } from '../../harnesses';
import { ago, busyCount, laneSummary } from './fleetDerive';
import { FleetPromptForm } from './FleetPromptForm';

type Props = {
  project: FleetProject;
  // Set for a project on a paired PC.
  machine?: string;
  isActive: boolean;
  now: number;
  prompting: boolean;
  selectedTerminal: string | null;
  onPrompt: (open: boolean) => void;
  onLaunched: (r: FleetLaunchResult) => void;
  onFiled: (message: string) => void;
  onOpenTerminal: (t: FleetTerminal) => void;
  onSwitch: () => void;
};

export function FleetProjectCard({ project: p, machine, isActive, now, prompting, selectedTerminal, onPrompt, onLaunched, onFiled, onOpenTerminal, onSwitch }: Props) {
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);
  const merging = p.runs.some((r) => r.kind === 'merge');
  const merge = () => {
    setMergeMsg('Starting merge…');
    startFleetMergeRun(p.path, machine)
      .then(() => setMergeMsg(null))
      .catch((e) => setMergeMsg(e instanceof Error ? e.message : String(e)));
  };
  return (
    <section className={`fleet-card${isActive ? ' is-active' : ''}`}>
      <div className="fleet-card-head">
        <div className="fleet-card-title" title={p.path}>
          <strong>{p.name}</strong>
          {isActive && <span className="fleet-tag">this tab</span>}
          {busyCount(p) > 0 && <span className="fleet-tag is-busy">{busyCount(p)} working</span>}
          <span className="fleet-muted"> · {p.lastActivityAt ? ago(p.lastActivityAt, now) : '—'}</span>
        </div>
        <div className="fleet-card-actions">
          {p.lanes.ready_to_merge > 0 && !merging && (
            <button className="icon-btn sm" onClick={merge} title={`Merge the ${p.lanes.ready_to_merge} ready task(s)`} aria-label={`Merge ready tasks in ${p.name}`}>
              <GitMerge size={13} />
            </button>
          )}
          <button className="icon-btn sm" onClick={() => onPrompt(!prompting)} title="Prompt an agent in this project" aria-label={`Prompt an agent in ${p.name}`}>
            <MessageSquarePlus size={13} />
          </button>
          {!isActive && !machine && (
            <button className="icon-btn sm" onClick={onSwitch} title="Switch this tab to this project" aria-label={`Switch to ${p.name}`}>
              <FolderOpen size={13} />
            </button>
          )}
        </div>
      </div>
      <div className="fleet-card-lanes">{laneSummary(p.lanes)}</div>
      {p.runs.map((r) => (
        <div key={r.id} className="fleet-line">
          <span className="fleet-dot is-run" />
          {r.label} <span className="fleet-muted">({r.status})</span>
        </div>
      ))}
      {p.inProgress.map((t) => (
        <div key={t.id} className="fleet-line" title={t.title}>
          <span className="fleet-dot is-task" />
          <span className="fleet-ellipsis">{t.title}</span>
          {(t.harness || t.model) && <span className="fleet-muted"> · {[t.harness ? harnessLabel(t.harness) : '', t.model ?? ''].filter(Boolean).join(' ')}</span>}
        </div>
      ))}
      {p.agents.map((a) => (
        <div key={a.agentId} className="fleet-line">
          <span className="fleet-dot is-agent" />
          {a.label}
          {a.harness && <span className="fleet-muted"> · {harnessLabel(a.harness)}</span>}
        </div>
      ))}
      <FleetReviewList tasks={p.toReview} project={p.path} machine={machine} />
      {mergeMsg && <div className="fleet-muted">{mergeMsg}</div>}
      {p.terminals.length > 0 && (
        <div className="fleet-terms">
          {p.terminals.map((t) => (
            <button
              key={t.id}
              className={`fleet-term-chip${t.busy ? ' is-busy' : ''}${selectedTerminal === t.id ? ' is-selected' : ''}`}
              onClick={() => onOpenTerminal(t)}
              title={`${t.label}${t.busy ? ' — working' : ' — idle'}${t.lastOutputAt ? ` · last output ${ago(t.lastOutputAt, now)} ago` : ''}`}
            >
              <span className="fleet-dot" />
              {t.label}
            </button>
          ))}
        </div>
      )}
      {prompting && <FleetPromptForm project={p.path} machine={machine} onLaunched={onLaunched} onFiled={onFiled} onCancel={() => onPrompt(false)} />}
    </section>
  );
}
