import { useState } from 'react';
import { DownloadCloud } from 'lucide-react';
import {
  applyMcpImport,
  scanMcpImport,
  type ImportedServerInfo,
} from '../../../api';

type Props = {
  activeFolder: string;
  // Refresh the catalog after a successful import.
  onImported: () => void;
};

// "Import from existing tools": scan the user's other agent configs, present a
// checklist of discovered servers (+ which keys come along), and bring the
// selected ones into Lattice's catalog with zero re-entry.
export function McpImportSection({ activeFolder, onImported }: Props) {
  const [scanned, setScanned] = useState<ImportedServerInfo[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const scan = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await scanMcpImport(activeFolder);
      setScanned(res.servers);
      // Pre-check everything importable (non-colliding).
      setSelected(new Set(res.servers.filter((s) => !s.collides).map((s) => s.id)));
      if (res.servers.length === 0) setMsg('No MCP servers found in other tools.');
    } catch (err) {
      // Surface the failure in the section's own message slot — an unhandled
      // rejection here left the button silently doing nothing.
      setMsg(`Scan failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await applyMcpImport(ids, activeFolder);
      setMsg(
        `Imported ${res.imported.length} server${res.imported.length === 1 ? '' : 's'}` +
          (res.skipped.length ? `, skipped ${res.skipped.length} (already present).` : '.') +
          ' Enable them per-project above.',
      );
      setScanned(null);
      setSelected(new Set());
      onImported();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mcp-import">
      <div className="mcp-import-head">
        <button className="btn-ghost sm" onClick={scan} disabled={busy}>
          <DownloadCloud size={13} /> Import from existing tools
        </button>
        <span className="mcp-import-sub">
          Scans Claude Code, Cursor, Codex, VS Code, and Windsurf configs.
        </span>
      </div>

      {scanned && scanned.length > 0 && (
        <div className="mcp-import-list">
          {scanned.map((s) => {
            const checked = selected.has(s.id);
            return (
              <label
                key={`${s.source}:${s.id}`}
                className={`mcp-import-row ${s.collides ? 'collides' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked && !s.collides}
                  disabled={s.collides}
                  onChange={(e) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    });
                  }}
                />
                <div className="mcp-import-row-text">
                  <div className="mcp-import-row-title">
                    {s.label}
                    <span className="mcp-import-source">{s.source}</span>
                    {s.collides && <span className="mcp-chip off">already in catalog</span>}
                  </div>
                  <div className="mcp-import-row-summary">{s.summary}</div>
                  {s.secretVars.length > 0 && (
                    <div className="mcp-import-row-secrets">
                      {s.secretVars.map((v) => (
                        <span key={v.envVar} className={`mcp-chip ${v.stored ? 'on' : 'warn'}`}>
                          {v.envVar}: {v.stored ? 'key imported' : 'from env'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
          <div className="mcp-import-actions">
            <button
              className="btn-primary sm"
              onClick={apply}
              disabled={busy || selected.size === 0}
            >
              {busy ? 'Importing…' : `Import ${selected.size} selected`}
            </button>
          </div>
        </div>
      )}

      {msg && <div className="mcp-import-msg">{msg}</div>}
    </div>
  );
}
