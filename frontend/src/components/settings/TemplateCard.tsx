import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type { InstructionTemplate } from '../../api';
import { useTokenInsertion } from './useTokenInsertion';

// One collapsible instruction-template editor: header (title / Modified badge /
// filename / reset), the editable textarea, and the click-to-insert token list.
export function TemplateCard({
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
  const { textareaRef, insertToken } = useTokenInsertion(draft, onChange);
  const isDefault = draft === tpl.defaultTemplate;

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
