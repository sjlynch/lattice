import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { McpServerEntry } from '../../../api';

type Props = {
  // Ids already taken (built-ins + existing customs) so we can reject dupes.
  existingIds: Set<string>;
  onAdd: (entry: McpServerEntry) => void | Promise<void>;
};

// Minimal "add a custom server" form (stdio or http). Definitions only — any
// key the server needs is entered afterward through the row's key field /
// imported, never typed here in plaintext.
export function McpAddCustom({ existingIds, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [id, setId] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setId('');
    setCommand('');
    setArgs('');
    setUrl('');
    setError(null);
    setTransport('stdio');
  };

  const submit = async () => {
    const slug = id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) return setError('Name is required.');
    if (existingIds.has(slug)) return setError(`"${slug}" already exists.`);
    if (transport === 'stdio' && !command.trim()) return setError('Command is required.');
    if (transport === 'http' && !url.trim()) return setError('URL is required.');

    const entry: McpServerEntry = {
      id: slug,
      label: id.trim() || slug,
      description: 'Custom server.',
      transport,
      runtime: transport === 'http' ? 'remote' : 'node',
      harnessSupport: { claude: true, codex: true, pi: false },
      builtin: false,
    };
    if (transport === 'stdio') {
      entry.command = command.trim();
      const parsed = args.trim() ? args.trim().split(/\s+/) : [];
      if (parsed.length) entry.args = parsed;
    } else {
      entry.url = url.trim();
    }

    setBusy(true);
    setError(null);
    try {
      await onAdd(entry);
      reset();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="btn-ghost sm mcp-add-toggle" onClick={() => setOpen(true)}>
        <Plus size={13} /> Add a custom server
      </button>
    );
  }

  return (
    <div className="mcp-add-form">
      <div className="mcp-add-row">
        <select
          className="settings-select"
          value={transport}
          onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
        >
          <option value="stdio">stdio (command)</option>
          <option value="http">http (url)</option>
        </select>
        <input
          className="text-input"
          placeholder="name (e.g. my-server)"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
      </div>
      {transport === 'stdio' ? (
        <div className="mcp-add-row">
          <input
            className="text-input"
            placeholder="command (e.g. npx)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className="text-input"
            placeholder="args (space-separated, e.g. -y my-mcp@latest)"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
        </div>
      ) : (
        <div className="mcp-add-row">
          <input
            className="text-input"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      )}
      {error && <div className="error-msg">{error}</div>}
      <div className="mcp-add-actions">
        <button
          className="btn-ghost sm"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={busy}
        >
          Cancel
        </button>
        <button className="btn-primary sm" onClick={submit} disabled={busy}>
          {busy ? 'Adding…' : 'Add server'}
        </button>
      </div>
    </div>
  );
}
