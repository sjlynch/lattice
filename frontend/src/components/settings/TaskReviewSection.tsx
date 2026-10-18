import { ALL_AGENT_EFFORTS, type AgentEffort } from '../../harnesses';
import { useHarnessAvailability } from '../../hooks/useHarnessAvailability';
import { usePiModelMenu } from '../../hooks/usePiModelMenu';
import { StartTasksHarnessSelect } from '../workflows/StartTasksHarnessSelect';
import { StepLaunchSelects } from '../workflows/StepLaunchSelects';
import type { useTaskReviewDraft } from './useTaskReviewDraft';

export function TaskReviewSection({ draft }: { draft: ReturnType<typeof useTaskReviewDraft> }) {
  const { harnessAvail } = useHarnessAvailability();
  const piMenu = usePiModelMenu();
  const { values, set } = draft;
  const harness = values.taskReviewHarness ?? 'codex';
  return (
    <div className="settings-section">
      <div className="settings-section-title">Second opinion</div>
      <div className="settings-section-sub">
        A reviewer reads each finished task's change before it is ready to merge. Re-run starts the task over with the model you pick here; the first attempt's commits stay on a kept branch.
      </div>
      <label className="settings-review-field">
        Mode
        <select className="text-input" value={values.taskReview ?? 'off'}
          onChange={(e) => set({ taskReview: e.target.value as 'off' | 'flag' | 'rerun' })}>
          <option value="off">Off</option>
          <option value="flag">Flag doubtful tasks</option>
          <option value="rerun">Re-run doubtful tasks once</option>
        </select>
      </label>
      {values.taskReview && values.taskReview !== 'off' && <>
        <label className="settings-review-field">
          Reviewer harness
          <select className="text-input" value={harness}
            onChange={(e) => set({ taskReviewHarness: e.target.value as 'codex' | 'claude' })}>
            <option value="codex">Codex</option><option value="claude">Claude</option>
          </select>
        </label>
        <label className="settings-review-field">
          Reviewer model
          <input className="text-input" value={values.taskReviewModel ?? ''}
            placeholder={harness === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-5-5'}
            onChange={(e) => set({ taskReviewModel: e.target.value })} />
        </label>
        {harness === 'codex' && <label className="settings-review-field">
          Reviewer effort
          <select className="text-input" value={values.taskReviewEffort ?? 'low'}
            onChange={(e) => set({ taskReviewEffort: e.target.value as AgentEffort })}>
            {ALL_AGENT_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
          </select>
        </label>}
        {values.taskReview === 'rerun' && <div className="settings-review-field">
          <span>Re-run with</span>
          <StartTasksHarnessSelect harnessAvail={harnessAvail} piMenu={piMenu}
            harness={values.taskReviewRerunHarness} piModel={values.taskReviewRerunPiModel}
            defaultLabel="Choose a rerun harness (otherwise flag)"
            onChange={(next, piModel) => set({ taskReviewRerunHarness: next, taskReviewRerunPiModel: piModel })} />
          {values.taskReviewRerunHarness && <StepLaunchSelects harness={values.taskReviewRerunHarness}
            model={values.taskReviewRerunModel} effort={values.taskReviewRerunEffort} subject="tasks"
            onChange={(patch) => set({ taskReviewRerunModel: patch.model, taskReviewRerunEffort: patch.effort })} />}
        </div>}
      </>}
    </div>
  );
}
