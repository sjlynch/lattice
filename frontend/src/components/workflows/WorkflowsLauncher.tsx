import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListChecks, Play, Plus, Square, Trash2, X } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import {
  cancelWorkflowRun as apiCancelWorkflowRun,
  startWorkflow as apiStartWorkflow,
  fetchHarnessAvailability,
  type HarnessAvailability,
  type Workflow,
  type WorkflowRun,
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
import { useWorkflowQueue } from './hooks/useWorkflowQueue';

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

  // Which agent CLIs are installed — drives the per-step harness selector.
  // Detected once; defaults to Claude-only until the probe returns.
  const [harnessAvail, setHarnessAvail] = useState<HarnessAvailability>({
    claude: true,
    pi: false,
    codex: false,
  });
  useEffect(() => {
    let cancelled = false;
    fetchHarnessAvailability().then((avail) => {
      if (!cancelled) setHarnessAvail(avail);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const workflowsById = useMemo(() => {
    const map = new Map<string, Workflow>();
    for (const wf of workflows) map.set(wf.id, wf);
    return map;
  }, [workflows]);

  const activeRunList = useMemo(
    () => Object.values(activeRuns).sort((a, b) => a.startedAt - b.startedAt),
    [activeRuns],
  );

  const startWorkflowDefinition = useCallback(async (wf: Workflow): Promise<WorkflowRun | null> => {
    try {
      const res = await apiStartWorkflow(wf.id);
      addActiveRun(res.run);
      return res.run;
    } catch (err) {
      showError(`Run failed: ${(err as Error).message}`);
      return null;
    }
  }, [addActiveRun]);

  const runWorkflow = useCallback(async (wf: Workflow): Promise<WorkflowRun | null> => {
    let target = wf;
    if (editor.dirty && editor.workflowId === wf.id) {
      // Persist before run so the engine sees the latest steps.
      const saved = await save();
      if (!saved) return null;
      target = saved;
    }
    return startWorkflowDefinition(target);
  }, [editor.dirty, editor.workflowId, save, startWorkflowDefinition]);

  // Queue scheduler — pure state machine in queueScheduler.ts. The hook
  // dispatches HTTP /run for each workflow the scheduler asks to start and
  // dispatches `runFinished` when a run leaves activeRuns. The "start two
  // sequential workflows, get two terminals" bug was a race in the prior
  // in-effect IIFE; the reducer makes the "exactly one in flight at a time"
  // invariant explicit.
  const { state: queueState, dispatch: dispatchQueue } = useWorkflowQueue({
    workflowsById,
    runWorkflow,
    activeRuns,
  });

  const queuedWorkflows = queueState.queued
    .map((id) => workflowsById.get(id))
    .filter((wf): wf is Workflow => Boolean(wf));

  const enqueueWorkflow = useCallback(
    (wf: Workflow) => {
      if (wf.steps.length === 0) return;
      dispatchQueue({ type: 'enqueue', workflowId: wf.id });
    },
    [dispatchQueue],
  );

  const removeQueuedWorkflow = useCallback(
    (workflowId: string) => {
      dispatchQueue({ type: 'removeFromQueue', workflowId });
    },
    [dispatchQueue],
  );

  const startQueuedWorkflows = useCallback(() => {
    dispatchQueue({ type: 'startQueue' });
  }, [dispatchQueue]);

  // Match the prior in-component semantics: `queueBusy` reflects an HTTP /run
  // in flight, not "queue is processing a long-running workflow". A
  // workflow whose run is mid-stream still has `queueBusy === false`, so
  // controls like Clear / Remove-from-queue stay interactive.
  const queueBusy = queueState.started.some((s) => s.runId === null);
  const queueRunning = queueState.running;
  const queueMode = queueState.mode;

  async function stopRun(runId: string) {
    try {
      await apiCancelWorkflowRun(runId);
    } catch (err) {
      showError(`Stop failed: ${(err as Error).message}`);
    }
  }

  async function runEditorWorkflow() {
    if (!editor.workflowId || editor.dirty) {
      const saved = await save();
      if (saved) await startWorkflowDefinition(saved);
      return;
    }
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (fresh) await runWorkflow(fresh);
  }

  async function enqueueEditorWorkflow() {
    if (!editor.workflowId || editor.dirty) {
      const saved = await save();
      if (saved) enqueueWorkflow(saved);
      return;
    }
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (fresh) enqueueWorkflow(fresh);
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

  const queueDisabled = queueState.queued.length === 0 && !queueRunning;
  const queueActive = queueState.started.find((s) => {
    const runId = s.runId;
    return runId !== null && activeRuns[runId];
  });
  const queueStatus = queueRunning
    ? queueActive
      ? 'Running current workflow; next queued item starts when it finishes.'
      : queueBusy
        ? 'Starting next queued workflow…'
        : 'Waiting to start next queued workflow…'
    : queueState.queued.length > 0
      ? `${queueState.queued.length} workflow${queueState.queued.length === 1 ? '' : 's'} queued.`
      : 'Queue saved workflows, then choose sequential or parallel start.';

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
        defaultSize={{ width: 1080, height: 620 }}
        minSize={{ width: 760, height: 420 }}
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
                  const run = activeRunList.find((r) => r.workflowId === w.id);
                  const isSel = editor.workflowId === w.id;
                  const queued = queueState.queued.includes(w.id);
                  return (
                    <div
                      key={w.id}
                      className={`workflows-item ${isSel ? 'active' : ''}`}
                      onClick={() => setEditor(fromWorkflow(w))}
                    >
                      <div className="workflows-item-name">{w.name}</div>
                      <div className="workflows-item-meta">
                        {w.steps.length} step{w.steps.length === 1 ? '' : 's'}
                        {queued && (
                          <>
                            {' · '}
                            <span className="workflows-item-queued">queued</span>
                          </>
                        )}
                        {run && (
                          <>
                            {' · '}
                            <span className="workflows-item-run">
                              running {run.currentStepIndex + 1}/{run.totalSteps}
                            </span>
                          </>
                        )}
                      </div>
                      <div className="workflows-item-actions">
                        {run ? (
                          <button
                            className="workflows-item-run-btn danger"
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
                          <>
                            <button
                              className="workflows-item-run-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                enqueueWorkflow(w);
                              }}
                              disabled={w.steps.length === 0 || queued}
                              title={queued ? 'Already queued' : 'Add to queue'}
                              aria-label="Add workflow to queue"
                            >
                              <Plus size={12} />
                            </button>
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
                                  : 'Run workflow now'
                              }
                              aria-label="Run workflow now"
                            >
                              <Play size={11} fill="currentColor" />
                            </button>
                          </>
                        )}
                      </div>
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
                      harnessAvail={harnessAvail}
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
                    onClick={() => void save()}
                    disabled={editor.steps.length === 0}
                  >
                    {editor.workflowId ? 'Save' : 'Create'}
                  </button>
                  <button
                    className="btn-ghost"
                    onClick={() => void enqueueEditorWorkflow()}
                    disabled={editor.steps.length === 0 || !activeFolder}
                  >
                    <Plus size={11} /> Queue
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
                      onClick={() => void runEditorWorkflow()}
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

          <aside className="workflows-runs">
            <div className="workflows-list-head">
              <span className="workflows-list-title">Queue & active</span>
            </div>
            <div className="workflows-queue-mode" role="group" aria-label="Workflow queue mode">
              <button
                className={queueMode === 'sequential' ? 'active' : ''}
                onClick={() => dispatchQueue({ type: 'setMode', mode: 'sequential' })}
                disabled={queueRunning}
                title="Run one queued workflow after the previous one finishes"
              >
                Sequential
              </button>
              <button
                className={queueMode === 'parallel' ? 'active' : ''}
                onClick={() => dispatchQueue({ type: 'setMode', mode: 'parallel' })}
                disabled={queueRunning}
                title="Start all queued workflows at once"
              >
                Parallel
              </button>
            </div>
            <div className="workflows-queue-controls">
              <button
                className="btn-primary"
                onClick={startQueuedWorkflows}
                disabled={queueDisabled || queueRunning}
              >
                <Play size={11} fill="currentColor" /> Start queue
              </button>
              {queueRunning ? (
                <button
                  className="btn-ghost"
                  onClick={() => dispatchQueue({ type: 'stopQueue' })}
                >
                  Stop queue
                </button>
              ) : (
                <button
                  className="btn-ghost"
                  onClick={() => dispatchQueue({ type: 'clearQueue' })}
                  disabled={queueState.queued.length === 0}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="workflows-queue-status">{queueStatus}</div>

            <div className="workflows-runs-section">
              <div className="workflows-runs-section-title">Queued</div>
              {queuedWorkflows.length === 0 ? (
                <div className="workflows-runs-empty">No queued workflows.</div>
              ) : (
                <div className="workflows-runs-list">
                  {queuedWorkflows.map((wf, idx) => (
                    <div key={wf.id} className="workflows-run-card queued">
                      <div className="workflows-run-card-main">
                        <span className="workflows-run-card-name">{idx + 1}. {wf.name}</span>
                        <span className="workflows-run-card-meta">
                          {wf.steps.length} step{wf.steps.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <button
                        className="icon-btn sm"
                        onClick={() => removeQueuedWorkflow(wf.id)}
                        aria-label="Remove from queue"
                        title="Remove from queue"
                        disabled={queueRunning && queueBusy}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="workflows-runs-section">
              <div className="workflows-runs-section-title">Active</div>
              {activeRunList.length === 0 ? (
                <div className="workflows-runs-empty">No active workflow runs.</div>
              ) : (
                <div className="workflows-runs-list">
                  {activeRunList.map((run) => {
                    const pos = Math.min(run.currentStepIndex + 1, run.totalSteps);
                    const pct = run.totalSteps > 0 ? Math.round((pos / run.totalSteps) * 100) : 0;
                    return (
                      <div key={run.id} className="workflows-run-card active">
                        <div className="workflows-run-card-main">
                          <span className="workflows-run-card-name">{run.workflowName}</span>
                          <span className="workflows-run-card-meta">
                            Step {pos}/{run.totalSteps} · {pct}%
                          </span>
                          <div className="workflows-run-progress" aria-hidden>
                            <span style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                        <button
                          className="icon-btn sm danger"
                          onClick={() => stopRun(run.id)}
                          aria-label="Stop workflow run"
                          title="Stop workflow run"
                        >
                          <Square size={10} fill="currentColor" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>
        {error && (
          <ErrorToast message={error} onDismiss={() => setError(null)} />
        )}
      </FloatingPanel>
    </>
  );
}
