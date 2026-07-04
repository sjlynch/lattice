import { Check, Eye, EyeOff, ExternalLink, X } from 'lucide-react';
import { type McpSecretRequirement } from '../../../api';
import { useSecretField } from './useSecretField';

type Props = {
  serverId: string;
  requirement: McpSecretRequirement;
  // Whether a key is already stored (presence only — never the value).
  stored: boolean;
  // Last-4 hint like "••••cD3f", if a key is stored.
  hint?: string;
  // Whether the env var is present in the backend's ambient environment.
  envPresent: boolean;
  // Re-fetch secrets/presence after a change.
  onChanged: () => void;
  // Whether this server has a per-server validator (v1: brave-search only).
  testable: boolean;
};

// The §8 masked-but-confirmable key field: ambient-detected state, inline entry,
// "Get a key" deep link, show/hide, last-4 confirmation, autosave-on-blur, and a
// one-click Test. The edit/commit/clear/test state machine lives in
// useSecretField; this component is just its rendering. Secrets autosave
// immediately (separate store) — they do NOT wait for the dialog's Save button.
export function McpKeyField({
  serverId,
  requirement,
  stored,
  hint,
  envPresent,
  onChanged,
  testable,
}: Props) {
  const field = useSecretField({
    serverId,
    envVar: requirement.envVar,
    stored,
    envPresent,
    onChanged,
  });
  const { editing, value, reveal, busy, test, saveError } = field;

  return (
    <div className="mcp-key-field">
      <div className="mcp-key-label">{requirement.label}</div>

      {!editing && stored && (
        <div className="mcp-key-stored">
          <span className="mcp-key-hint">{hint || '••••••••'}</span>
          <button className="mcp-link-btn" onClick={field.startEditing} disabled={busy}>
            Replace
          </button>
          <button className="mcp-link-btn danger" onClick={field.clear} disabled={busy}>
            Clear
          </button>
        </div>
      )}

      {!editing && !stored && envPresent && (
        <div className="mcp-key-ambient">
          Detected from your environment ✓ — no entry needed.
          <button className="mcp-link-btn" onClick={field.startEditing} disabled={busy}>
            Override
          </button>
        </div>
      )}

      {editing && (
        <div className="mcp-key-input-row">
          <input
            className="text-input mcp-key-input"
            type={reveal ? 'text' : 'password'}
            placeholder={`Paste your ${requirement.label}`}
            value={value}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => field.changeValue(e.target.value)}
            onBlur={field.commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void field.commit();
              }
            }}
          />
          <button
            className="icon-btn sm"
            type="button"
            title={reveal ? 'Hide' : 'Show'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={field.toggleReveal}
          >
            {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          {(stored || envPresent) && (
            <button
              className="mcp-link-btn"
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={field.cancelEditing}
              disabled={busy}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {saveError && (
        <div className="mcp-key-error" role="alert">
          <X size={12} /> {saveError}
        </div>
      )}

      <div className="mcp-key-actions">
        {requirement.getKeyUrl && (
          <a
            className="mcp-link-btn"
            href={requirement.getKeyUrl}
            target="_blank"
            rel="noreferrer"
          >
            Get a key <ExternalLink size={11} />
          </a>
        )}
        {testable && (stored || envPresent) && (
          <button className="mcp-link-btn" onClick={field.runTest} disabled={busy}>
            {busy ? 'Testing…' : 'Test'}
          </button>
        )}
        {test && (
          <span className={`mcp-test-result ${test.ok ? 'ok' : 'fail'}`}>
            {test.ok ? <Check size={12} /> : <X size={12} />} {test.msg}
          </span>
        )}
      </div>
    </div>
  );
}
