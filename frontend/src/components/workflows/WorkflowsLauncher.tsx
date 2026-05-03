import { useEffect, useMemo, useState } from 'react';
import { Lightbulb, ListChecks, Play, Plus, Trash2, Wrench, X } from 'lucide-react';
import { FloatingPanel } from '../FloatingPanel';
import { useTerminals } from '../../TerminalsContext';
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
} from '../../api';
import { WORKFLOW_TEMPLATES, type WorkflowTemplate } from '../../workflowTemplates';
import { ErrorToast } from '../shared/ErrorToast';
import {
  emptyEditor,
  fromTemplate,
  fromWorkflow,
  localStepId,
  type EditorState,
} from './editorState';
import { StepRow } from './StepRow';
import { WorkflowRunStrip } from './WorkflowRunStrip';

type Props = {
  activeFolder: string;
};

type DefaultPrompt = {
  id: string;
  title: string;
  label: string;
  icon: typeof Wrench;
  prompt: string;
};

// Quick-insert prompts surfaced as chips at the bottom of the editor. Each
// click appends a new step seeded with the prompt body. Keep these prompts
// self-sufficient — they may be the only step a user runs.
const DEFAULT_PROMPTS: DefaultPrompt[] = [
  {
    id: 'refactor',
    title: 'Refactor',
    label: 'Refactor',
    icon: Wrench,
    prompt:
      'Refactor the code surface described above without changing its observable behavior. ' +
      'Look for duplication, unclear naming, tangled responsibilities, and modules that have ' +
      'drifted past a comfortable size, and tighten them up. Keep public APIs stable, preserve ' +
      'existing tests, and run a type-check before committing. In the commit message, briefly ' +
      'explain what was restructured and why — do not list every file touched.',
  },
  {
    id: 'brainstorm',
    title: 'Brainstorm',
    label: 'Brainstorm',
    icon: Lightbulb,
    prompt:
      'Brainstorm 3–5 distinct approaches to the problem described above. Do not write any ' +
      'production code yet. For each approach, sketch the rough shape of the solution, list the ' +
      'main tradeoffs (complexity, blast radius, ergonomics, performance, reversibility), and ' +
      'flag any unknowns that need investigation before committing to a direction. Write your ' +
      'findings to BRAINSTORM.md at the worktree root, end with a recommendation and the ' +
      'reasoning behind it, and commit the file.',
  },
];

// Top-level Workflows panel. Owns workflow list/run state, hydrates from
// the WS, and routes per-step terminal spawns to the global TerminalsContext.
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

  // Append a step seeded from a default-prompt chip. If the editor is empty
  // (no workflow loaded, no steps), bootstrap a draft so clicking a chip
  // from the empty state immediately produces something runnable.
  function addDefaultPromptStep(p: DefaultPrompt) {
    setEditor((cur) => {
      const base =
        cur.workflowId === null && cur.steps.length === 0 && cur.name === ''
          ? { workflowId: null, name: p.title, steps: [], dirty: true }
          : cur;
      return {
        ...base,
        steps: [
          ...base.steps,
          {
            id: localStepId(),
            title: p.title,
            prompt: p.prompt,
            mode: 'sequential',
          },
        ],
        dirty: true,
      };
    });
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
