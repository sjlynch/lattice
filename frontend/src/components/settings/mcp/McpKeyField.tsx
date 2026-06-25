import { useState } from 'react';
import { Check, Eye, EyeOff, ExternalLink, X } from 'lucide-react';
import {
  setMcpSecret,
  validateMcpServer,
  type McpSecretRequirement,
} from '../../../api';
import { commitMcpSecret } from './commitMcpSecret';

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
// one-click Test. Secrets autosave immediately (separate store) — they do NOT
// wait for the dialog's Save button.
export function McpKeyField({
  serverId,
  requirement,
  stored,
  hint,
  envPresent,
  onChanged,
  testable,
}: Props) {
  const [editing, setEditing] = useState(!stored && !envPresent);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const commit = async () => {
    const v = value.trim();
    if (!v) {
      setEditing(stored ? false : !envPresent);
      return;
    }
    setBusy(true);
    setSaveError(null);
    const result = await commitMcpSecret(serverId, requirement.envVar, v);
    setBusy(false);
    if (!result.ok) {
      // Autosave-on-blur bypasses the dialog's Save-button error path, so the
      // failure has to surface here. Keep the field open with the typed value
      // intact so the user can retry rather than believing the key saved.
      setSaveError(result.error);
      return;
    }
    setValue('');
    setEditing(false);
    setTest(null);
    setSaveError(null);
    onChanged();
  };

  const clear = async () => {
    setBusy(true);
    try {
      await setMcpSecret(serverId, requirement.envVar, null);
      setValue('');
      setTest(null);
      setSaveError(null);
      setEditing(!envPresent);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const res = await validateMcpServer(serverId);
      setTest({ ok: res.ok, msg: res.ok ? 'Key works.' : res.error || 'Failed.' });
    } catch (err) {
      setTest({ ok: false, msg: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-key-field">
      <div className="mcp-key-label">{requirement.label}</div>

      {!editing && stored && (
        <div className="mcp-key-stored">
          <span className="mcp-key-hint">{hint || '••••••••'}</span>
          <button className="mcp-link-btn" onClick={() => setEditing(true)} disabled={busy}>
            Replace
          </button>
          <button className="mcp-link-btn danger" onClick={clear} disabled={busy}>
            Clear
          </button>
        </div>
      )}

      {!editing && !stored && envPresent && (
        <div className="mcp-key-ambient">
          Detected from your environment ✓ — no entry needed.
          <button className="mcp-link-btn" onClick={() => setEditing(true)} disabled={busy}>
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
            onChange={(e) => {
              setValue(e.target.value);
              if (saveError) setSaveError(null);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commit();
              }
            }}
          />
          <button
            className="icon-btn sm"
            type="button"
            title={reveal ? 'Hide' : 'Show'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setReveal((r) => !r)}
          >
            {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          {(stored || envPresent) && (
            <button
              className="mcp-link-btn"
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setValue('');
                setEditing(false);
                setSaveError(null);
              }}
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
          <button className="mcp-link-btn" onClick={runTest} disabled={busy}>
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
