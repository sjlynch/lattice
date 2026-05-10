import { useState } from 'react';
import { ListChecks, Play, Plus, Square, Trash2, X } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import {
  cancelWorkflowRun as apiCancelWorkflowRun,
  startWorkflow as apiStartWorkflow,
  type Workflow,
} from '../../api';
import { WORKFLOW_TEMPLATES } from '../../workflowTemplates';
import { ErrorToast } from '../shared/ErrorToast';
import { fromWorkflow } from './editorState';
import { StepRow } from './StepRow';
import { WorkflowRunStrip } from './WorkflowRunStrip';
import { DEFAULT_PROMPTS } from './defaultPrompts';
import { useCollapsedSteps } from './hooks/useCollapsedSteps';
import { useWorkflowList } from './hooks/useWorkflowList';
import { useWorkflowRuns } from './hooks/useWorkflowRuns';
import { useWorkflowEditor } from './hooks/useWorkflowEditor';

type Props = {
  activeFolder: string;
};

// Top-level Workflows panel. Composes list/run/editor hooks and renders the
// editor shell; per-step terminal spawns are routed through TerminalsContext
// inside `useWorkflowRuns`.
export function WorkflowsLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function showError(msg: string) {
    setError(msg);
    setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 5000);
  }

  const { isCollapsed, toggleCollapsed } = useCollapsedSteps(activeFolder);

  const { workflows, sortedWorkflows } = useWorkflowList(activeFolder);
  const { activeRuns, recentRuns, addActiveRun, dismissRecent } =
    useWorkflowRuns(activeFolder);
  const {
    editor,
    setEditor,
    pickingTemplate,
    setPickingTemplate,
    newBlank,
    newFromTemplate,
    save,
    discardEdits,
    deleteCurrent,
    patchStep,
    removeStep,
    addStep,
    addDefaultPromptStep,
    reorderSteps,
  } = useWorkflowEditor({ workflows, activeFolder, onError: showError });

  async function runWorkflow(wf: Workflow) {
    if (editor.dirty && editor.workflowId === wf.id) {
      // Persist before run so the engine sees the latest steps.
      try {
        await save();
      } catch {
        return;
      }
    }
    try {
      const res = await apiStartWorkflow(wf.id);
      addActiveRun(res.run);
    } catch (err) {
      showError(`Run failed: ${(err as Error).message}`);
    }
  }

  async function stopRun(runId: string) {
    try {
      await apiCancelWorkflowRun(runId);
    } catch (err) {
      showError(`Stop failed: ${(err as Error).message}`);
    }
  }

  // Find any active/recent run for the currently-edited workflow so the
  // strip in the editor head reflects the right run.
  const runForEditor = editor.workflowId
    ? activeRuns[
        Object.keys(activeRuns).find(
          (k) => activeRuns[k].workflowId === editor.workflowId,
        ) ?? ''
      ]
    : undefined;
  const recentForEditor = editor.workflowId
    ? recentRuns[
        Object.keys(recentRuns).find(
          (k) => recentRuns[k].workflowId === editor.workflowId,
        ) ?? ''
      ]
    : undefined;

  const activeRunList = Object.values(activeRuns);

  return (
    <>
      <button
        className="fab"
        onClick={() => setOpen(true)}
        title="Open workflow editor"
        aria-label="Open workflow editor"
      >
        <ListChecks size={15} />
        <span>Workflows</span>
        {workflows.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 2 }}>
            · {workflows.length}
          </span>
        )}
      </button>

      {activeRunList.length > 0 && (
        <button
          className="wf-run-chip"
          onClick={() => setOpen(true)}
          title="Open workflow editor"
          aria-label="Workflow runs in progress"
        >
          <span className="wf-run-chip-spinner" />
          <span className="wf-run-chip-text">
            {activeRunList.length === 1
              ? (() => {
                  const run = activeRunList[0];
                  const pos = Math.min(run.currentStepIndex + 1, run.totalSteps);
                  return `${run.workflowName} · Step ${pos}/${run.totalSteps}`;
                })()
              : `${activeRunList.length} workflows running`}
          </span>
        </button>
      )}

      <FloatingPanel
        open={open}
        onClose={() => setOpen(false)}
        title={
          <>
            <ListChecks size={13} />
            Workflows
          </>
        }
        defaultSize={{ width: 820, height: 620 }}
        minSize={{ width: 560, height: 380 }}
        storageKey="lattice.workflows.window"
      >
        <div className="workflows-body">
          <aside className="workflows-list">
            <div className="workflows-list-head">
              <span className="workflows-list-title">Saved</span>
              <div className="workflows-list-actions">
                <button
                  className="icon-btn sm"
                  onClick={() => setPickingTemplate((v) => !v)}
                  title="New from template"
                  aria-label="New from template"
                >
                  <ListChecks size={12} />
                </button>
                <button
                  className="icon-btn sm"
                  onClick={newBlank}
                  title="New blank workflow"
                  aria-label="New blank workflow"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            {pickingTemplate && (
              <div className="workflows-templates">
                <div className="workflows-templates-head">
                  <span>Templates</span>
                  <button
                    className="icon-btn sm"
                    onClick={() => setPickingTemplate(false)}
                    aria-label="Close templates"
                  >
                    <X size={12} />
                  </button>
                </div>
                {WORKFLOW_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    className="workflows-template"
                    onClick={() => newFromTemplate(t)}
                    title={t.description}
                  >
                    <div className="workflows-template-name">{t.name}</div>
                    <div className="workflows-template-desc">{t.description}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="workflows-list-items">
              {sortedWorkflows.length === 0 ? (
                <div className="workflows-empty">
                  No workflows yet. Click <Plus size={11} style={{ verticalAlign: -1 }} /> to
                  create one, or <ListChecks size={11} style={{ verticalAlign: -1 }} /> for
                  a template.
                </div>
              ) : (
                sortedWorkflows.map((w) => {
                  const run = Object.values(activeRuns).find(
                    (r) => r.workflowId === w.id,
                  );
                  const isSel = editor.workflowId === w.id;
                  return (
                    <div
                      key={w.id}
                      className={`workflows-item ${isSel ? 'active' : ''}`}
                      onClick={() => setEditor(fromWorkflow(w))}
                    >
                      <div className="workflows-item-name">{w.name}</div>
                      <div className="workflows-item-meta">
                        {w.steps.length} step{w.steps.length === 1 ? '' : 's'}
                        {run && (
                          <>
                            {' · '}
                            <span className="workflows-item-run">
                              running {run.currentStepIndex + 1}/{run.totalSteps}
                            </span>
                          </>
                        )}
                      </div>
                      {run ? (
                        <button
                          className="workflows-item-run-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            stopRun(run.id);
                          }}
                          title="Stop workflow run"
                          aria-label="Stop workflow run"
                        >
                          <Square size={10} fill="currentColor" />
                        </button>
                      ) : (
                        <button
                          className="workflows-item-run-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            runWorkflow(w);
                          }}
                          disabled={w.steps.length === 0}
                          title={
                            w.steps.length === 0
                              ? 'Add steps before running'
                              : 'Run workflow'
                          }
                          aria-label="Run workflow"
                        >
                          <Play size={11} fill="currentColor" />
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          <section className="workflows-editor">
            {editor.workflowId === null && editor.steps.length === 0 ? (
              <div className="workflows-editor-empty">
                <ListChecks size={28} />
                <div className="workflows-editor-empty-title">
                  Build a chain of prompts.
                </div>
                <div className="workflows-editor-empty-sub">
                  Each step becomes a task on the board. Run each step
                  manually; when it merges and reaches QA, the next step
                  appears automatically.
                </div>
                <div className="workflows-editor-empty-actions">
                  <button className="btn-primary" onClick={newBlank}>
                    <Plus size={12} /> New blank
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => setPickingTemplate(true)}
                  >
                    <ListChecks size={12} /> From template
                  </button>
                </div>
                <div className="workflows-default-prompts">
                  <span className="workflows-default-prompts-label">
                    Quick add
                  </span>
                  {DEFAULT_PROMPTS.map((p) => {
                    const Icon = p.icon;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="workflows-prompt-chip"
                        onClick={() => addDefaultPromptStep(p)}
                        title={p.prompt}
                      >
                        <Icon size={11} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <>
                <div className="workflows-editor-head">
                  <input
                    className="task-card-form-input workflows-editor-name"
                    placeholder="Workflow name"
                    value={editor.name}
                    onChange={(e) =>
                      setEditor((cur) => ({
                        ...cur,
                        name: e.target.value,
                        dirty: true,
                      }))
                    }
                  />
                  {(runForEditor || recentForEditor) && (
                    <WorkflowRunStrip
                      active={runForEditor ?? null}
                      summary={!runForEditor ? recentForEditor ?? null : null}
                      onStop={runForEditor ? () => stopRun(runForEditor.id) : undefined}
                      onDismiss={() => {
                        if (recentForEditor) dismissRecent(recentForEditor.id);
                      }}
                    />
                  )}
                </div>
                <div className="workflows-editor-steps">
                  {editor.steps.map((step, idx) => (
                    <StepRow
                      key={step.id}
                      step={step}
                      index={idx}
                      collapsed={isCollapsed(step.id)}
                      onChange={(patch) => patchStep(idx, patch)}
                      onRemove={() => removeStep(idx)}
                      onReorder={reorderSteps}
                      onToggleCollapse={() => toggleCollapsed(step.id)}
                    />
                  ))}
                  <button className="workflows-add-step" onClick={addStep}>
                    <Plus size={12} /> Add step
                  </button>
                </div>
                <div className="workflows-default-prompts">
                  <span className="workflows-default-prompts-label">
                    Quick add
                  </span>
                  {DEFAULT_PROMPTS.map((p) => {
                    const Icon = p.icon;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="workflows-prompt-chip"
                        onClick={() => addDefaultPromptStep(p)}
                        title={p.prompt}
                      >
                        <Icon size={11} />
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <div className="workflows-editor-actions">
                  {editor.workflowId && (
                    <button
                      className="btn-ghost"
                      onClick={deleteCurrent}
                      style={{ color: 'var(--danger)' }}
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                  <span style={{ flex: 1 }} />
                  {editor.dirty && (
                    <button className="btn-ghost" onClick={discardEdits}>
                      Discard
                    </button>
                  )}
                  <button
                    className="btn-ghost"
                    onClick={save}
                    disabled={editor.steps.length === 0}
                  >
                    {editor.workflowId ? 'Save' : 'Create'}
                  </button>
                  {runForEditor ? (
                    <button
                      className="btn-ghost"
                      onClick={() => stopRun(runForEditor.id)}
                      style={{ color: 'var(--danger)' }}
                    >
                      <Square size={11} fill="currentColor" /> Stop
                    </button>
                  ) : (
                    <button
                      className="btn-primary"
                      onClick={async () => {
                        if (!editor.workflowId || editor.dirty) await save();
                        const id = editor.workflowId;
                        const fresh =
                          (id && workflows.find((w) => w.id === id)) ?? null;
                        if (fresh) await runWorkflow(fresh);
                      }}
                      disabled={
                        editor.steps.length === 0 ||
                        !activeFolder
                      }
                    >
                      <Play size={11} fill="currentColor" /> Run
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
        {error && (
          <ErrorToast message={error} onDismiss={() => setError(null)} />
        )}
      </FloatingPanel>
    </>
  );
}
