import { FolderOpen, MessageSquarePlus } from 'lucide-react';
import type { FleetLaunchResult, FleetProject, FleetTerminal } from '../../api';
import { harnessLabel } from '../../harnesses';
import { ago, busyCount, laneSummary } from './fleetDerive';
import { FleetPromptForm } from './FleetPromptForm';

type Props = {
  project: FleetProject;
  isActive: boolean;
  now: number;
  prompting: boolean;
  selectedTerminal: string | null;
  onPrompt: (open: boolean) => void;
  onLaunched: (r: FleetLaunchResult) => void;
  onOpenTerminal: (t: FleetTerminal) => void;
  onSwitch: () => void;
};

export function FleetProjectCard({ project: p, isActive, now, prompting, selectedTerminal, onPrompt, onLaunched, onOpenTerminal, onSwitch }: Props) {
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
          <button className="icon-btn sm" onClick={() => onPrompt(!prompting)} title="Prompt an agent in this project" aria-label={`Prompt an agent in ${p.name}`}>
            <MessageSquarePlus size={13} />
          </button>
          {!isActive && (
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
      {prompting && <FleetPromptForm project={p.path} onLaunched={onLaunched} onCancel={() => onPrompt(false)} />}
    </section>
  );
}
