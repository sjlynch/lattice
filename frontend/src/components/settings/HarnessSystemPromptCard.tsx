import { useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { HarnessSystemPromptEntry } from '../../api';

// One collapsible per-harness system-prompt editor: header (title / Modified
// badge), a read-only view of the harness's built-in default, and the two
// editable overrides — Append (added on top of the default) and Replace (swaps
// it entirely, with a per-harness warning).
export function HarnessSystemPromptCard({
  entry,
  append,
  replace,
  onChangeAppend,
  onChangeReplace,
}: {
  entry: HarnessSystemPromptEntry;
  append: string;
  replace: string;
  onChangeAppend: (text: string) => void;
  onChangeReplace: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const modified = append.trim().length > 0 || replace.trim().length > 0;

  return (
    <div className="prompt-tpl-card">
      <div className="prompt-tpl-card-head">
        <button
          type="button"
          className="prompt-tpl-head"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="prompt-tpl-title">{entry.title}</span>
          {modified && <span className="prompt-tpl-modified">Modified</span>}
        </button>
      </div>
      {expanded && (
        <div className="prompt-tpl-body">
          <div className="prompt-tpl-desc">{entry.overview}</div>

          <div className="hsp-field-label">
            Default system prompt
            <span className="hsp-field-tag">
              {entry.defaultViewable ? 'read-only' : 'not viewable'}
            </span>
          </div>
          <pre className="hsp-default">{entry.defaultPrompt}</pre>
          {entry.sourceUrl && (
            <a
              className="hsp-source-link"
              href={entry.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink size={11} />
              {entry.sourceLabel ?? 'Source'}
            </a>
          )}

          <div className="hsp-field-label">Append</div>
          <div className="hsp-field-desc">{entry.appendDescription}</div>
          <textarea
            className="text-input prompt-tpl-editor"
            value={append}
            spellCheck={false}
            rows={6}
            placeholder="Extra instructions appended to the built-in prompt (leave blank for none)"
            onChange={(e) => onChangeAppend(e.target.value)}
          />

          <div className="hsp-field-label">
            Replace<span className="hsp-field-tag hsp-field-tag-warn">advanced</span>
          </div>
          <div className="hsp-field-desc">{entry.replaceDescription}</div>
          {entry.replaceWarning && (
            <div className="hsp-warning">{entry.replaceWarning}</div>
          )}
          <textarea
            className="text-input prompt-tpl-editor"
            value={replace}
            spellCheck={false}
            rows={6}
            placeholder="Full replacement system prompt (leave blank to keep the built-in default)"
            onChange={(e) => onChangeReplace(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
