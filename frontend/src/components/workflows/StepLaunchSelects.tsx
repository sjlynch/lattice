import { ALL_AGENT_EFFORTS, type AgentEffort, type AgentHarness } from '../../harnesses';

// Claude Code's model aliases; any other id a step was saved with stays
// selectable. Codex models have no presets (a saved one is still shown).
const CLAUDE_MODEL_PRESETS = ['opus', 'sonnet', 'fable', 'haiku'];

// The model + reasoning-effort selects of a step that launches agents: its own
// agent, or — on a Start step (`subject="tasks"`) — the tasks it starts.
// Empty = the harness default. Pi has no model select (its model is part of
// the harness select).
export function StepLaunchSelects({
  harness,
  model,
  effort,
  subject = 'step',
  onChange,
}: {
  harness?: AgentHarness;
  model?: string;
  effort?: AgentEffort;
  subject?: 'step' | 'tasks';
  onChange: (patch: { model?: string; effort?: AgentEffort }) => void;
}) {
  const who = subject === 'tasks' ? 'the tasks this step starts' : 'this step';
  const presets = harness === 'codex' ? [] : CLAUDE_MODEL_PRESETS;
  const models = model && !presets.includes(model) ? [...presets, model] : presets;
  return (
    <>
      {harness !== 'pi' && (
        <select
          className="workflows-step-harness workflows-step-launch"
          value={model ?? ''}
          onChange={(e) => onChange({ model: e.target.value || undefined, effort })}
          title={`Model for ${who} (Claude/Codex; ignored for Pi). Default = the harness's own.`}
        >
          <option value="">Model: default</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      )}
      <select
        className="workflows-step-harness workflows-step-launch"
        value={effort ?? ''}
        onChange={(e) =>
          onChange({ model, effort: (e.target.value || undefined) as AgentEffort | undefined })
        }
        title={`Reasoning effort for ${who}. Default = the harness's own.`}
      >
        <option value="">Effort: default</option>
        {ALL_AGENT_EFFORTS.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
    </>
  );
}
