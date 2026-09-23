import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  fetchInstructionTemplates,
  fetchUserSettingsStrict,
  type InstructionTemplate,
  type UserSettings,
} from '../../api';
import { useOverrideDraft } from './useOverrideDraft';
import { TemplateCard } from './TemplateCard';

type Props = {
  active: boolean;
  open: boolean;
  activeFolder: string;
};

export type InstructionTemplatesTabHandle = {
  // The full desired `instructionTemplateOverrides` map (replaces the saved
  // one), or undefined until the fetch that seeds drafts has completed (so a
  // save before load can't clobber existing overrides).
  getInstructionTemplateOverridesPatch: () => Record<string, string> | undefined;
  // `taskAgentTypecheck`, or undefined unless the user flipped the checkbox.
  getTaskAgentTypecheckPatch: () => boolean | undefined;
};

// Stable (module-level) config for the shared override-draft engine. A draft
// drops its override key — falling back to Lattice's default — when it's blank
// or exactly equals the default template.
const idOf = (t: InstructionTemplate) => t.id;
const defaultOf = (t: InstructionTemplate) => t.defaultTemplate;
const currentOf = (t: InstructionTemplate) => t.currentTemplate;
const readOverrides = (s: UserSettings) => s.instructionTemplateOverrides ?? {};
const matchesDefault = (draft: string, t: InstructionTemplate) =>
  draft.trim().length === 0 || draft === t.defaultTemplate;

// The "task agents may type-check" checkbox (`taskAgentTypecheck`, default
// OFF). Seeded from the project settings on each open; only a user flip
// produces a patch, so a slow or failed GET can never write the default over
// a saved value.
function useTaskAgentTypecheckDraft(open: boolean, activeFolder: string) {
  const [typecheck, setTypecheck] = useState(false);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!open || !activeFolder) return;
    let cancelled = false;
    setTouched(false);
    fetchUserSettingsStrict(activeFolder)
      .then((s) => {
        if (!cancelled) setTypecheck(s.taskAgentTypecheck === true);
      })
      .catch(() => { /* untouched → no patch */ });
    return () => {
      cancelled = true;
    };
  }, [open, activeFolder]);
  const set = (value: boolean) => {
    setTouched(true);
    setTypecheck(value);
  };
  return { typecheck, setTypecheck: set, patch: touched ? typecheck : undefined };
}

function useInstructionTemplatesDraft(open: boolean, active: boolean, activeFolder: string) {
  const {
    items: templates,
    draftMap: drafts,
    loading,
    error,
    setDraft,
    resetDraft,
    resetAll,
    getPatch,
  } = useOverrideDraft<InstructionTemplate>({
    open,
    active,
    activeFolder,
    fetchItems: fetchInstructionTemplates,
    readOverrides,
    idOf,
    defaultOf,
    currentOf,
    matchesDefault,
  });

  return {
    templates,
    drafts,
    loading,
    error,
    setDraft,
    resetDraft,
    resetAll,
    getInstructionTemplateOverridesPatch: getPatch,
  };
}

export const InstructionTemplatesTab = forwardRef<InstructionTemplatesTabHandle, Props>(
  function InstructionTemplatesTab({ active, open, activeFolder }, ref) {
    const {
      templates,
      drafts,
      loading,
      error,
      setDraft,
      resetDraft,
      resetAll,
      getInstructionTemplateOverridesPatch,
    } = useInstructionTemplatesDraft(open, active, activeFolder);
    const [expanded, setExpanded] = useState<string | null>(null);
    const verification = useTaskAgentTypecheckDraft(open, activeFolder);
    const typecheckPatch = verification.patch;

    useImperativeHandle(
      ref,
      () => ({
        getInstructionTemplateOverridesPatch,
        getTaskAgentTypecheckPatch: () => typecheckPatch,
      }),
      [getInstructionTemplateOverridesPatch, typecheckPatch],
    );

    if (!active) return null;

    const anyModified = templates.some(
      (t) => (drafts[t.id] ?? t.currentTemplate) !== t.defaultTemplate,
    );

    return (
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Instruction templates</div>
            <div className="settings-section-sub">
              The briefs Lattice writes for the agents it spawns. Edit any of
              them to change what every agent is told — your text is saved per
              project. The <code>{'{{tokens}}'}</code> are the dynamic parts
              Lattice fills in at spawn (task title, IDs, callback URLs, computed
              blocks); leave them in place. Clear a box or click Reset to fall
              back to Lattice's default.
            </div>
          </div>
          {templates.length > 0 && (
            <button
              type="button"
              className="btn-ghost sm"
              onClick={resetAll}
              disabled={!anyModified}
              title="Reset every prompt back to Lattice's default"
            >
              <RotateCcw size={12} />
              Reset all
            </button>
          )}
        </div>
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={verification.typecheck}
            onChange={(e) => verification.setTypecheck(e.target.checked)}
          />
          <span>Task agents may type-check what they edited</span>
        </label>
        <div className="settings-section-sub">
          By default task agents (and their merge-conflict resolvers) run no
          tests, builds or type-checks — a workflow's Run tests step verifies
          the merged work once instead of every agent at once. On, an agent may
          type-check the package(s) it edited; in a fresh worktree that costs a
          dependency install plus a cold build per task. The rule rides the
          Task brief's <code>{'{{verification}}'}</code> token (appended if a
          custom brief drops it) and the agent's system prompt, so it applies
          to resumed tasks and custom briefs too.
        </div>
        {loading ? (
          <div className="settings-empty">Loading…</div>
        ) : error ? (
          <div className="error-msg">{error}</div>
        ) : templates.length === 0 ? (
          <div className="settings-empty">No instruction templates.</div>
        ) : (
          <div className="prompt-tpl-list">
            {templates.map((tpl) => (
              <TemplateCard
                key={tpl.id}
                tpl={tpl}
                draft={drafts[tpl.id] ?? tpl.currentTemplate}
                expanded={expanded === tpl.id}
                onToggle={() =>
                  setExpanded((cur) => (cur === tpl.id ? null : tpl.id))
                }
                onChange={(text) => setDraft(tpl.id, text)}
                onReset={() => resetDraft(tpl)}
              />
            ))}
          </div>
        )}
      </div>
    );
  },
);
