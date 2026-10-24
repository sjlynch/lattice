import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchFleet, patchGlobalSettings, type FleetEvent, type FleetHost, type FleetMachine, type FleetProject } from '../../api';
import { sameProjectPath } from '../../terminal/terminalScope';
import { usePanelWindow } from '../../hooks/usePanelDocument';
import { ago, feedNewestFirst, hostSummary, mergeFeed, projectMatches, projectName } from './fleetDerive';
import { FleetProjectCard } from './FleetProjectCard';
import { FleetTerminalViewer } from './FleetTerminalViewer';
import { FleetPeersPanel } from './FleetPeersPanel';

type Props = {
  activeFolder: string;
  onSelectFolder: (path: string) => void;
};

const POLL_MS = 3000;

// The Fleet panel body: every project with something going on (left) and the
// machine-wide activity feed or one terminal's live screen (right). Polls
// GET /api/fleet while open; the feed accumulates by `seq`.
export function FleetPanel({ activeFolder, onSelectFolder }: Props) {
  const [projects, setProjects] = useState<FleetProject[]>([]);
  const [feed, setFeed] = useState<FleetEvent[]>([]);
  const [agentControl, setAgentControl] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [prompting, setPrompting] = useState<string | null>(null);
  const [machines, setMachines] = useState<FleetMachine[]>([]);
  const [host, setHost] = useState<FleetHost | undefined>(undefined);
  const [showPeers, setShowPeers] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ id: string; label: string; project: string; machine?: string } | null>(null);
  const seqRef = useRef(0);
  // The window Fleet is in now — its pop-out's when popped out, so polling
  // follows THAT window's visibility and its timers aren't throttled with a
  // minimised main window.
  const win = usePanelWindow();

  const poll = useCallback(() => {
    if (win.document.hidden) return;
    fetchFleet(seqRef.current)
      .then((snap) => {
        // A backend restart starts a fresh feed: its seq goes backwards.
        if (snap.seq < seqRef.current) {
          seqRef.current = 0;
          setFeed([]);
          return;
        }
        seqRef.current = snap.seq;
        setProjects(snap.projects);
        setMachines(snap.machines ?? []);
        if (snap.host) setHost(snap.host);
        setFeed((f) => mergeFeed(f, snap.events));
        setAgentControl(snap.agentControl);
        setNow(snap.generatedAt);
        setLoaded(true);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [win]);

  useEffect(() => {
    poll();
    const timer = win.setInterval(poll, POLL_MS);
    return () => win.clearInterval(timer);
  }, [poll, win]);

  const toggleAgentControl = (on: boolean) => {
    setAgentControl(on);
    patchGlobalSettings({ fleetAgentControl: on }).catch(() => setAgentControl(!on));
  };

  const shown = projects.filter((p) => projectMatches(p, filter));
  return (
    <div className="fleet">
      <div className="fleet-bar">
        <input
          className="text-input fleet-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter projects, terminals, tasks…"
          aria-label="Filter projects"
        />
        <label
          className="fleet-check"
          title="When on, agents (MCP fleet tools in sessions you start, or scripted API calls) may open agent terminals in any project, read, type into and wait on any terminal, and file, run and merge tasks on other boards. Off by default. This panel is never gated."
        >
          <input type="checkbox" checked={agentControl} onChange={(e) => toggleAgentControl(e.target.checked)} />
          Let agents act in any project (terminals, tasks, merges)
        </label>
        <button className="btn-ghost sm" onClick={() => { setViewing(null); setShowPeers((v) => !v); }} title="Pair other PCs running Lattice">
          PCs{machines.length ? ` (${machines.length})` : ''}
        </button>
      </div>
      {host && <div className="fleet-host" title="This PC: installed harnesses, curated Pi models, plan usage"><strong>{host.name}</strong> <span className="fleet-muted">· {hostSummary(host)}</span></div>}
      {error && <div className="error-msg">Fleet unavailable: {error}</div>}
      {notice && (
        <div className="fleet-notice" role="status">
          {notice}
          <button className="btn-ghost sm" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      <div className="fleet-body">
        <div className="fleet-projects">
          {!loaded && !error && <div className="fleet-muted fleet-empty">Loading…</div>}
          {loaded && !shown.length && <div className="fleet-muted fleet-empty">No active projects{filter ? ' match' : ''}.</div>}
          {shown.map((p) => (
            <FleetProjectCard
              key={p.path}
              project={p}
              isActive={sameProjectPath(p.path, activeFolder)}
              now={now}
              prompting={prompting === p.path}
              selectedTerminal={viewing?.id ?? null}
              onPrompt={(open) => setPrompting(open ? p.path : null)}
              onLaunched={(r) => {
                setPrompting(null);
                setViewing({ id: r.id, label: r.label, project: p.name });
                poll();
              }}
              onFiled={(message) => {
                setPrompting(null);
                setNotice(`${p.name}: ${message}`);
                poll();
              }}
              onOpenTerminal={(t) => { setShowPeers(false); setViewing({ id: t.id, label: t.label, project: p.name }); }}
              onSwitch={() => onSelectFolder(p.path)}
            />
          ))}
          {machines.map((m) => (
            <div key={m.name} className="fleet-machine">
              <div className="fleet-machine-head">
                <strong>{m.name}</strong>
                <span className="fleet-muted">{m.ok ? ` · ${(m.projects ?? []).length} active project(s)${m.host ? ` · ${hostSummary(m.host)}` : ''}` : ` · unreachable${m.error ? `: ${m.error}` : ''}`}</span>
              </div>
              {(m.projects ?? []).filter((p) => projectMatches(p, filter)).map((p) => (
                <FleetProjectCard
                  key={`${m.name}:${p.path}`}
                  project={p}
                  machine={m.name}
                  isActive={false}
                  now={now}
                  prompting={prompting === `${m.name}:${p.path}`}
                  selectedTerminal={viewing?.machine === m.name ? viewing.id : null}
                  onPrompt={(open) => setPrompting(open ? `${m.name}:${p.path}` : null)}
                  onLaunched={(r) => {
                    setPrompting(null);
                    setShowPeers(false);
                    setViewing({ id: r.id, label: r.label, project: p.name, machine: m.name });
                    poll();
                  }}
                  onFiled={(message) => {
                    setPrompting(null);
                    setNotice(`${m.name} · ${p.name}: ${message}`);
                    poll();
                  }}
                  onOpenTerminal={(t) => { setShowPeers(false); setViewing({ id: t.id, label: t.label, project: p.name, machine: m.name }); }}
                  onSwitch={() => {}}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="fleet-side">
          {showPeers ? (
            <FleetPeersPanel onClose={() => setShowPeers(false)} onChanged={poll} />
          ) : viewing ? (
            <FleetTerminalViewer key={`${viewing.machine ?? ''}:${viewing.id}`} id={viewing.id} label={viewing.label} projectName={viewing.project} machine={viewing.machine} onClose={() => setViewing(null)} />
          ) : (
            <div className="fleet-feed">
              <div className="fleet-feed-head">Activity across projects</div>
              {!feed.length && <div className="fleet-muted fleet-empty">Nothing yet — task moves, runs, agents and terminals from every project show up here.</div>}
              {feedNewestFirst(feed).map((e) => (
                <div key={e.seq} className={`fleet-event kind-${e.kind}`}>
                  <span className="fleet-event-time">{ago(e.at, now)}</span>
                  <span className="fleet-event-project" title={e.projectPath}>{projectName(e.projectPath)}</span>
                  <span className="fleet-event-text">{e.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
