import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GripVertical,
  ListChecks,
  Play,
  Plus,
  Trash2,
  X,
  AlertTriangle,
  Copy,
  Check,
} from 'lucide-react';
import { FloatingPanel } from './FloatingPanel';
import { useTerminals } from '../TerminalsContext';
import {
  createWorkflow as apiCreateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  fetchWorkflows,
  startWorkflow as apiStartWorkflow,
  subscribeWorkflowRuns,
  subscribeWorkflows,
  updateWorkflow as apiUpdateWorkflow,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStepMode,
} from '../api';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../workflowTemplates';

const DRAG_MIME = 'application/x-lattice-workflow-step';

type Props = {
  activeFolder: string;
};

type EditorState = {
  workflowId: string | null;
  name: string;
  steps: WorkflowStep[];
  dirty: boolean;
};

function emptyEditor(): EditorState {
  return { workflowId: null, name: '', steps: [], dirty: false };
}

function localStepId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function fromTemplate(t: WorkflowTemplate): EditorState {
  return {
    workflowId: null,
    name: t.name,
    steps: t.steps.map((s) => ({ ...s, id: localStepId() })),
    dirty: true,
  };
}

function fromWorkflow(w: Workflow): EditorState {
  return {
    workflowId: w.id,
    name: w.name,
    steps: w.steps.map((s) => ({ ...s })),
    dirty: false,
  };
}

export function WorkflowsLauncher({ activeFolder }: Props) {
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const [error, setError] = useState<string | null>(null);
  const [activeRuns, setActiveRuns] = useState<Record<string, WorkflowRun>>({});
  const [recentRuns, setRecentRuns] = useState<Record<string, WorkflowRun>>({});
  const [pickingTemplate, setPickingTemplate] = useState(false);
  const { addTerminal } = useTerminals();

  // Initial fetch + WS subscription per active folder.
  useEffect(() => {
    if (!activeFolder) {
      setWorkflows([]);
      return;
    }
    let cancelled = false;
    fetchWorkflows(activeFolder)
      .then((ws) => { if (!cancelled) setWorkflows(ws); })
      .catch((err) => console.error('fetchWorkflows', err));
    const unsub = subscribeWorkflows(activeFolder, (ws) => {
      if (!cancelled) setWorkflows(ws);
    });
    return () => { cancelled = true; unsub(); };
  }, [activeFolder]);

  // Workflow run events: drive the progress strip + spawn terminals for
  // auto-advanced steps. The first step's terminal is opened by the run
  // button click handler; later steps arrive via the 'task-spawned' event.
  useEffect(() => {
    if (!activeFolder) {
      setActiveRuns({});
      return;
    }
    let cancelled = false;
    const unsub = subscribeWorkflowRuns(activeFolder, (ev) => {
      if (cancelled) return;
      if (ev.type === 'hello') {
        const map: Record<string, WorkflowRun> = {};
        for (const r of ev.runs) map[r.id] = r;
        setActiveRuns(map);
      } else if (ev.type === 'started' || ev.type === 'progress') {
        setActiveRuns((cur) => ({ ...cur, [ev.run.id]: ev.run }));
      } else if (ev.type === 'completed' || ev.type === 'errored') {
        setActiveRuns((cur) => {
          const next = { ...cur };
          delete next[ev.run.id];
          return next;
        });
        setRecentRuns((cur) => ({ ...cur, [ev.run.id]: ev.run }));
        const id = ev.run.id;
        setTimeout(() => {
          setRecentRuns((cur) => {
            if (!cur[id]) return cur;
            const next = { ...cur };
            delete next[id];
            return next;
          });
        }, 10000);
      } else if (ev.type === 'task-spawned') {
        addTerminal({
          label: `wf:${ev.taskId.slice(-6)}`,
          cwd: ev.worktreePath,
          initialCommand: ev.command,
          taskId: ev.taskId,
          projectPath: activeFolder,
        });
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [activeFolder, addTerminal]);

  // If the editor's loaded workflow gets edited from elsewhere (or deleted),
  // refresh the editor state — but never clobber an in-progress edit.
  useEffect(() => {
    if (!editor.workflowId) return;
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (!fresh) {
      setEditor(emptyEditor());
      return;
    }
    if (!editor.dirty) {
      setEditor(fromWorkflow(fresh));
    }
  }, [workflows, editor.workflowId, editor.dirty]);

  function showError(msg: string) {
    setError(msg);
    setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 5000);
  }

  function newBlank() {
    setEditor({
      workflowId: null,
      name: '',
      steps: [
        { id: localStepId(), title: 'Step 1', prompt: '', mode: 'sequential' },
      ],
      dirty: true,
    });
    setPickingTemplate(false);
  }

  async function newFromTemplate(t: WorkflowTemplate) {
    setPickingTemplate(false);
    if (!activeFolder) {
      // No project to attach to — fall back to a draft in the editor.
      setEditor(fromTemplate(t));
      return;
    }
    try {
      const created = await apiCreateWorkflow(
        activeFolder,
        t.name,
        t.steps.map((s) => ({ ...s, id: localStepId() })),
      );
      setEditor(fromWorkflow(created));
    } catch (err) {
      showError(`Could not create from template: ${(err as Error).message}`);
      setEditor(fromTemplate(t));
    }
  }

  async function save() {
    if (!activeFolder) return;
    const name = editor.name.trim() || 'Untitled workflow';
    const steps = editor.steps.map((s) => ({
      ...s,
      title: s.title.trim(),
      prompt: s.prompt,
    }));
    try {
      if (editor.workflowId) {
        const w = await apiUpdateWorkflow(editor.workflowId, { name, steps });
        setEditor(fromWorkflow(w));
      } else {
        const w = await apiCreateWorkflow(activeFolder, name, steps);
        setEditor(fromWorkflow(w));
      }
    } catch (err) {
      showError(`Save failed: ${(err as Error).message}`);
    }
  }

  async function discardEdits() {
    if (!editor.workflowId) {
      setEditor(emptyEditor());
      return;
    }
    const fresh = workflows.find((w) => w.id === editor.workflowId);
    if (fresh) setEditor(fromWorkflow(fresh));
  }

  async function deleteCurrent() {
    if (!editor.workflowId) return;
    try {
      await apiDeleteWorkflow(editor.workflowId);
      setEditor(emptyEditor());
    } catch (err) {
      showError(`Delete failed: ${(err as Error).message}`);
    }
  }

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
      addTerminal({
        label: `wf:${res.spawn.taskId.slice(-6)}`,
        cwd: res.spawn.worktreePath,
        initialCommand: res.spawn.command,
        taskId: res.spawn.taskId,
        projectPath: wf.projectPath,
      });
      setActiveRuns((cur) => ({ ...cur, [res.run.id]: res.run }));
    } catch (err) {
      showError(`Run failed: ${(err as Error).message}`);
    }
  }

  // ---- step editor mutations ----

  function patchStep(idx: number, patch: Partial<WorkflowStep>) {
    setEditor((cur) => ({
      ...cur,
      steps: cur.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
      dirty: true,
    }));
  }

  function removeStep(idx: number) {
    setEditor((cur) => ({
      ...cur,
      steps: cur.steps.filter((_, i) => i !== idx),
      dirty: true,
    }));
  }

  function addStep() {
    setEditor((cur) => ({
      ...cur,
      steps: [
        ...cur.steps,
        {
          id: localStepId(),
          title: `Step ${cur.steps.length + 1}`,
          prompt: '',
          mode: 'sequential',
        },
      ],
      dirty: true,
    }));
  }

  function reorderSteps(fromIdx: number, toIdx: number) {
    setEditor((cur) => {
      if (fromIdx === toIdx) return cur;
      const steps = [...cur.steps];
      const [moved] = steps.splice(fromIdx, 1);
      let insertAt = toIdx;
      if (fromIdx < toIdx) insertAt -= 1;
      steps.splice(insertAt, 0, moved);
      return { ...cur, steps, dirty: true };
    });
  }

  const sortedWorkflows = useMemo(
    () => [...workflows].sort((a, b) => b.createdAt - a.createdAt),
    [workflows],
  );

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
                      <button
                        className="workflows-item-run-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          runWorkflow(w);
                        }}
                        disabled={w.steps.length === 0 || !!run}
                        title={
                          w.steps.length === 0
                            ? 'Add steps before running'
                            : run
                              ? 'Run already in progress'
                              : 'Run workflow'
                        }
                        aria-label="Run workflow"
                      >
                        <Play size={11} fill="currentColor" />
                      </button>
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
                  Each step becomes a Lattice task. When one finishes (its
                  branch reaches QA), the next step auto-spawns in a fresh
                  worktree.
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
                      onDismiss={() => {
                        if (recentForEditor) {
                          const id = recentForEditor.id;
                          setRecentRuns((cur) => {
                            const next = { ...cur };
                            delete next[id];
                            return next;
                          });
                        }
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
                      onChange={(patch) => patchStep(idx, patch)}
                      onRemove={() => removeStep(idx)}
                      onReorder={reorderSteps}
                    />
                  ))}
                  <button className="workflows-add-step" onClick={addStep}>
                    <Plus size={12} /> Add step
                  </button>
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
                      !!runForEditor ||
                      !activeFolder
                    }
                  >
                    <Play size={11} fill="currentColor" /> Run
                  </button>
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

function StepRow({
  step,
  index,
  onChange,
  onRemove,
  onReorder,
}: {
  step: WorkflowStep;
  index: number;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onRemove: () => void;
  onReorder: (fromIdx: number, toIdx: number) => void;
}) {
  const [dragOver, setDragOver] = useState<'top' | 'bottom' | null>(null);

  function onDragStart(e: React.DragEvent) {
    e.dataTransfer.setData(DRAG_MIME, String(index));
    e.dataTransfer.setData('text/plain', String(index));
    e.dataTransfer.effectAllowed = 'move';
  }
  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const half = rect.top + rect.height / 2;
    setDragOver(e.clientY < half ? 'top' : 'bottom');
  }
  function onDragLeave() { setDragOver(null); }
  function onDrop(e: React.DragEvent) {
    const fromStr = e.dataTransfer.getData(DRAG_MIME);
    setDragOver(null);
    if (!fromStr) return;
    e.preventDefault();
    const fromIdx = Number(fromStr);
    if (Number.isNaN(fromIdx)) return;
    const toIdx = dragOver === 'bottom' ? index + 1 : index;
    onReorder(fromIdx, toIdx);
  }

  return (
    <div
      className={`workflows-step ${dragOver ? `drop-${dragOver}` : ''}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className="workflows-step-grip" aria-hidden>
        <GripVertical size={12} />
      </span>
      <div className="workflows-step-body">
        <div className="workflows-step-row">
          <span className="workflows-step-index">#{index + 1}</span>
          <input
            className="task-card-form-input workflows-step-title"
            placeholder="Step title"
            value={step.title}
            onChange={(e) => onChange({ title: e.target.value })}
          />
          <select
            className="workflows-step-mode"
            value={step.mode}
            onChange={(e) => onChange({ mode: e.target.value as WorkflowStepMode })}
            title="Sequential runs after the prior step finishes; parallel is reserved for the upcoming fan-out executor"
          >
            <option value="sequential">sequential</option>
            <option value="parallel">parallel</option>
          </select>
          <button
            className="icon-btn sm"
            onClick={onRemove}
            title="Remove step"
            aria-label="Remove step"
          >
            <X size={12} />
          </button>
        </div>
        <textarea
          className="task-card-form-input task-card-form-textarea workflows-step-prompt"
          placeholder="Prompt — written into LATTICE_TASK.md as the task description."
          value={step.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          rows={4}
        />
      </div>
    </div>
  );
}

function WorkflowRunStrip({
  active,
  summary,
  onDismiss,
}: {
  active: WorkflowRun | null;
  summary: WorkflowRun | null;
  onDismiss: () => void;
}) {
  if (active) {
    const pos = Math.min(active.currentStepIndex + 1, active.totalSteps);
    const pct =
      active.totalSteps > 0 ? Math.round((pos / active.totalSteps) * 100) : 0;
    return (
      <div className="merge-run-strip running" role="status">
        <span className="merge-run-strip-spinner" />
        <span className="merge-run-strip-text">
          Step {pos} of {active.totalSteps}
        </span>
        <span className="merge-run-strip-pct">{pct}%</span>
      </div>
    );
  }
  if (summary) {
    const errored = summary.status === 'errored';
    return (
      <div
        className={`merge-run-strip done ${errored ? 'cancelled' : ''}`}
        role="status"
      >
        <span className="merge-run-strip-text">
          {errored
            ? `Run errored: ${summary.error ?? 'unknown error'}`
            : 'Workflow complete'}
        </span>
        <button
          className="merge-run-strip-btn"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    );
  }
  return null;
}

function ErrorToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  async function copy() {
    try { await navigator.clipboard.writeText(message); } catch { /* ignore */ }
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="task-error-toast" role="alert">
      <span className="task-error-toast-icon" aria-hidden>
        <AlertTriangle size={14} />
      </span>
      <span className="task-error-toast-msg">{message}</span>
      <span className="task-error-toast-actions">
        <button
          className={`task-error-toast-btn ${copied ? 'copied' : ''}`}
          onClick={copy}
          aria-label="Copy"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button
          className="task-error-toast-btn"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          <X size={13} />
        </button>
      </span>
    </div>
  );
}

