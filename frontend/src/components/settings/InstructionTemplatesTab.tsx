import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import {
  fetchInstructionTemplates,
  fetchUserSettings,
  type InstructionTemplate,
} from '../../api';

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

function useInstructionTemplatesDraft(open: boolean, active: boolean, activeFolder: string) {
  const [templates, setTemplates] = useState<InstructionTemplate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [existingOverrides, setExistingOverrides] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch only once the tab is actually viewed (rendering the catalog is cheap,
  // but no reason to pay for it on every dialog open). Re-fetches on reopen /
  // project change.
  useEffect(() => {
    if (!open || !active || !activeFolder) return;
    let cancelled = false;
    setLoading(true);
    setLoaded(false);
    setError(null);
    Promise.all([
      fetchInstructionTemplates(activeFolder),
      fetchUserSettings(activeFolder),
    ])
      .then(([list, settings]) => {
        if (cancelled) return;
        setTemplates(list);
        setDrafts(Object.fromEntries(list.map((t) => [t.id, t.currentTemplate])));
        setExistingOverrides(settings.instructionTemplateOverrides ?? {});
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message || 'Failed to load templates');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, active, activeFolder]);

  const setDraft = useCallback((id: string, text: string) => {
    setDrafts((d) => ({ ...d, [id]: text }));
  }, []);

  const resetDraft = useCallback((tpl: InstructionTemplate) => {
    setDrafts((d) => ({ ...d, [tpl.id]: tpl.defaultTemplate }));
  }, []);

  const resetAll = useCallback(() => {
    setDrafts(Object.fromEntries(templates.map((t) => [t.id, t.defaultTemplate])));
  }, [templates]);

  // Build the map to persist: keep overrides for ids we don't manage, then for
  // each template store the edited text unless it matches the default or is
  // blank (either of which means "use Lattice's default" → drop the key).
  const getInstructionTemplateOverridesPatch = useCallback(():
    | Record<string, string>
    | undefined => {
    if (!loaded) return undefined;
    const next: Record<string, string> = { ...existingOverrides };
    for (const tpl of templates) {
      const draft = drafts[tpl.id] ?? tpl.currentTemplate;
      if (draft.trim().length === 0 || draft === tpl.defaultTemplate) {
        delete next[tpl.id];
      } else {
        next[tpl.id] = draft;
      }
    }
    return next;
  }, [loaded, existingOverrides, templates, drafts]);

  return {
    templates,
    drafts,
    loading,
    error,
    setDraft,
    resetDraft,
    resetAll,
    getInstructionTemplateOverridesPatch,
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

function TemplateCard({
  tpl,
  draft,
  expanded,
  onToggle,
  onChange,
  onReset,
}: {
  tpl: InstructionTemplate;
  draft: string;
  expanded: boolean;
  onToggle: () => void;
  onChange: (text: string) => void;
  onReset: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isDefault = draft === tpl.defaultTemplate;

  // Insert `{{token}}` at the cursor (or replace the selection) so users can
  // drop a token in without hand-typing the braces.
  const insertToken = (name: string) => {
    const el = textareaRef.current;
    const snippet = `{{${name}}}`;
    if (!el) {
      onChange(draft + snippet);
      return;
    }
    const start = el.selectionStart ?? draft.length;
    const end = el.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + snippet + draft.slice(end);
    onChange(next);
    // Restore focus + place the caret after the inserted token.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="prompt-tpl-card">
      <div className="prompt-tpl-card-head">
        <button type="button" className="prompt-tpl-head" onClick={onToggle}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="prompt-tpl-title">{tpl.title}</span>
          {!isDefault && <span className="prompt-tpl-modified">Modified</span>}
          <code className="prompt-tpl-filename">{tpl.filename}</code>
        </button>
        <button
          type="button"
          className="prompt-tpl-reset"
          onClick={onReset}
          disabled={isDefault}
          title="Reset this prompt to Lattice's default"
        >
          <RotateCcw size={13} />
        </button>
      </div>
      {expanded && (
        <div className="prompt-tpl-body">
          <div className="prompt-tpl-desc">{tpl.description}</div>
          <textarea
            ref={textareaRef}
            className="text-input prompt-tpl-editor"
            value={draft}
            spellCheck={false}
            rows={16}
            onChange={(e) => onChange(e.target.value)}
          />
          <div className="prompt-tpl-tokens">
            <div className="prompt-tpl-tokens-label">
              Tokens (click to insert at cursor)
            </div>
            {tpl.tokens.map((tok) => (
              <button
                type="button"
                key={tok.name}
                className="prompt-tpl-token"
                onClick={() => insertToken(tok.name)}
                title={tok.description}
              >
                <code>{`{{${tok.name}}}`}</code>
                <span className="prompt-tpl-token-desc">{tok.description}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
