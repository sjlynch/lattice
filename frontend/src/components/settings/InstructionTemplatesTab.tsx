import { forwardRef, useImperativeHandle, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import {
  fetchInstructionTemplates,
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

    useImperativeHandle(
      ref,
      () => ({ getInstructionTemplateOverridesPatch }),
      [getInstructionTemplateOverridesPatch],
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
