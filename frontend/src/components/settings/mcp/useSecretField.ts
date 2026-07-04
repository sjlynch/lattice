import { useState } from 'react';
import { setMcpSecret, validateMcpServer } from '../../../api';
import { commitMcpSecret } from './commitMcpSecret';

type Params = {
  serverId: string;
  envVar: string;
  // Whether a key is already stored (presence only — never the value).
  stored: boolean;
  // Whether the env var is present in the backend's ambient environment.
  envPresent: boolean;
  // Re-fetch secrets/presence after a change.
  onChanged: () => void;
};

export type SecretFieldTest = { ok: boolean; msg: string };

export type SecretField = {
  editing: boolean;
  value: string;
  reveal: boolean;
  busy: boolean;
  test: SecretFieldTest | null;
  saveError: string | null;
  // Enter edit mode (Replace / Override).
  startEditing: () => void;
  // Discard the in-progress entry and leave edit mode (Cancel).
  cancelEditing: () => void;
  // Update the typed value, clearing any stale save error.
  changeValue: (v: string) => void;
  toggleReveal: () => void;
  // Autosave the typed value (blur / Enter).
  commit: () => Promise<void>;
  // Delete the stored secret.
  clear: () => Promise<void>;
  // Run the server's key validator.
  runTest: () => Promise<void>;
};

// The implicit state machine behind McpKeyField: six pieces of coordinated
// state (editing/value/reveal/busy/test/saveError) and the commit/clear/test
// handlers that transition between them. Extracted so McpKeyField is just
// rendering. Secrets autosave immediately (separate store) — they do NOT wait
// for the dialog's Save button.
export function useSecretField({
  serverId,
  envVar,
  stored,
  envPresent,
  onChanged,
}: Params): SecretField {
  const [editing, setEditing] = useState(!stored && !envPresent);
  const [value, setValue] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<SecretFieldTest | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const startEditing = () => setEditing(true);

  const cancelEditing = () => {
    setValue('');
    setEditing(false);
    setSaveError(null);
  };

  const changeValue = (v: string) => {
    setValue(v);
    if (saveError) setSaveError(null);
  };

  const toggleReveal = () => setReveal((r) => !r);

  const commit = async () => {
    const v = value.trim();
    if (!v) {
      setEditing(stored ? false : !envPresent);
      return;
    }
    setBusy(true);
    setSaveError(null);
    const result = await commitMcpSecret(serverId, envVar, v);
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
      await setMcpSecret(serverId, envVar, null);
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

  return {
    editing,
    value,
    reveal,
    busy,
    test,
    saveError,
    startEditing,
    cancelEditing,
    changeValue,
    toggleReveal,
    commit,
    clear,
    runTest,
  };
}
