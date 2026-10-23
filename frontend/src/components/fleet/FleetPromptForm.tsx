import { useState } from 'react';
import { fileFleetTask, launchFleetAgent, type FleetLaunchResult } from '../../api';
import { ALL_AGENT_EFFORTS, harnessLabel, type AgentHarness } from '../../harnesses';
import { useHarnessAvailability } from '../../hooks/useHarnessAvailability';
import { usePiModelMenu } from '../../hooks/usePiModelMenu';
import { taskFromPrompt } from './fleetDerive';

type Props = {
  project: string;
  // A paired PC to launch on (through the peer proxy); default this PC.
  machine?: string;
  onLaunched: (r: FleetLaunchResult) => void;
  // The prompt was filed as a task there and started; says what happened.
  onFiled: (message: string) => void;
  onCancel: () => void;
};

// "Prompt this project": opens an agent terminal in it, already working on
// the request (it appears in that project's sidebar too) — or files it as a
// task on that board and runs it in its own worktree, to review and merge.
export function FleetPromptForm({ project, machine, onLaunched, onFiled, onCancel }: Props) {
  const { harnessAvail } = useHarnessAvailability();
  const piMenu = usePiModelMenu();
  const harnesses = (['claude', 'codex', 'pi'] as AgentHarness[]).filter((h) => harnessAvail[h]);
  const [harness, setHarness] = useState<AgentHarness>(harnesses[0] ?? 'claude');
  const [model, setModel] = useState('');
  const [piModel, setPiModel] = useState('');
  const [effort, setEffort] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = {
    harness,
    ...(harness !== 'pi' && model.trim() ? { model: model.trim() } : {}),
    ...(harness === 'pi' && piModel ? { piModel } : {}),
    ...(effort ? { effort } : {}),
  };
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  const start = () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    launchFleetAgent({ project, prompt, ...launch }, machine)
      .then(onLaunched)
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const fileTask = () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    fileFleetTask(project, taskFromPrompt(prompt), launch, machine)
      .then((t) => onFiled(t.runError
        ? `Filed “${t.title}” but could not start it (${t.runError}). Start it from that project's board.`
        : `Filed “${t.title}” and ${t.queued ? 'queued its run' : 'started it'}.`))
      .catch(fail)
      .finally(() => setBusy(false));
  };

  return (
    <div className="fleet-prompt">
      <div className="fleet-prompt-row">
        <select className="text-input" value={harness} onChange={(e) => setHarness(e.target.value as AgentHarness)} aria-label="Harness">
          {(harnesses.length ? harnesses : (['claude'] as AgentHarness[])).map((h) => (
            <option key={h} value={h}>{harnessLabel(h)}</option>
          ))}
        </select>
        {harness === 'pi' ? (
          <select className="text-input" value={piModel} onChange={(e) => setPiModel(e.target.value)} aria-label="Pi model">
            <option value="">Pi default model</option>
            {piMenu.map((m) => <option key={m.pattern} value={m.pattern}>{m.label}</option>)}
          </select>
        ) : (
          <input className="text-input" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model (optional)" aria-label="Model" />
        )}
        <select className="text-input" value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Effort">
          <option value="">Default effort</option>
          {ALL_AGENT_EFFORTS.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </div>
      <textarea
        className="text-input fleet-prompt-text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start(); }}
        placeholder="What should the agent do in this project? (Ctrl+Enter to start)"
        rows={4}
        autoFocus
      />
      {error && <div className="error-msg">{error}</div>}
      <div className="fleet-prompt-row fleet-prompt-actions">
        <button className="btn-ghost sm" onClick={onCancel}>Cancel</button>
        <button
          className="btn-ghost sm"
          onClick={fileTask}
          disabled={busy || !prompt.trim()}
          title="File this as a task on the project's board and run it in its own worktree; review and merge it when it is done"
        >
          Run as task
        </button>
        <button className="btn-primary sm" onClick={start} disabled={busy || !prompt.trim()}>
          {busy ? 'Starting…' : 'Start agent'}
        </button>
      </div>
    </div>
  );
}
