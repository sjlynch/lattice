import { ALL_AGENT_EFFORTS, type AgentEffort, type AgentHarness } from '../../harnesses';
import { useCodexModels } from '../../hooks/useCodexModels';
import { effortSuggestion } from '../../../../backend/src/shared/launchGuidance';

// Claude Code's model aliases; any other id a step was saved with stays
// selectable. Codex offers the models Codex lists in its own picker.
const CLAUDE_MODEL_PRESETS = ['opus', 'sonnet', 'fable', 'haiku'];

// The model + reasoning-effort selects of a step that launches agents: its own
// agent, or — on a Start step (`subject="tasks"`) — the tasks it starts.
// Empty = the harness default. Pi has no model select (its model is part of
// the harness select). An effort with benchmark evidence for this harness /
// model / role is labelled "suggested" (never applied automatically).
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
  const codexModels = useCodexModels(harness === 'codex');
  const presets = harness === 'codex' ? codexModels.map((m) => m.id) : CLAUDE_MODEL_PRESETS;
  const models = model && !presets.includes(model) ? [...presets, model] : presets;
  const suggestion = effortSuggestion(harness, model, subject);
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
            <option key={m} value={m} title={codexModels.find((c) => c.id === m)?.description}>
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
        title={
          `Reasoning effort for ${who}. Default = the harness's own.` +
          (suggestion ? `\nSuggested: ${suggestion.effort} — ${suggestion.why}` : '')
        }
      >
        <option value="">Effort: default</option>
        {ALL_AGENT_EFFORTS.map((level) => (
          <option key={level} value={level}>
            {level === suggestion?.effort ? `${level} · suggested` : level}
          </option>
        ))}
      </select>
    </>
  );
}
