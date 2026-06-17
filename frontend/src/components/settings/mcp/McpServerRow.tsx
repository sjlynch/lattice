import { Trash2 } from 'lucide-react';
import type { McpServerEntry } from '../../../api';
import { McpKeyField } from './McpKeyField';

type Props = {
  server: McpServerEntry;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  // Playwright's enable lives in qaPlaywright and is the QA lane's domain; the
  // row still toggles it but shows a hint pointing at the QA lane.
  playwrightHint?: boolean;
  // Secret state for a requiresSecret server.
  stored: boolean;
  hint?: string;
  envPresent: boolean;
  onSecretChanged: () => void;
  testable: boolean;
  // Custom (non-built-in) servers can be removed.
  onRemove?: () => void;
};

// One catalog row: enable toggle, label + description, per-harness badges,
// runtime caveat, the §8 status chip, and (for keyed servers) the inline key
// field.
export function McpServerRow({
  server,
  enabled,
  onToggle,
  playwrightHint,
  stored,
  hint,
  envPresent,
  onSecretChanged,
  testable,
  onRemove,
}: Props) {
  const keyed = !!server.requiresSecret;
  const chip = statusChip(enabled, keyed, stored, envPresent);

  return (
    <div className={`mcp-row ${enabled ? 'on' : ''}`}>
      <div className="mcp-row-main">
        <label className="mcp-toggle" title={enabled ? 'Enabled' : 'Disabled'}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggle(e.target.checked)}
          />
          <span className="mcp-toggle-track" />
        </label>
        <div className="mcp-row-text">
          <div className="mcp-row-title">
            {server.label}
            <span className={`mcp-chip ${chip.cls}`}>{chip.label}</span>
            {!server.builtin && <span className="mcp-chip custom">Custom</span>}
          </div>
          <div className="mcp-row-desc">{server.description}</div>
          <div className="mcp-row-meta">
            <McpHarnessBadges server={server} />
            {server.runtimeNote && (
              <span className="mcp-runtime-note">⚠ {server.runtimeNote}</span>
            )}
            {playwrightHint && (
              <span className="mcp-runtime-note">Also toggleable from the QA lane.</span>
            )}
          </div>
        </div>
        {onRemove && (
          <button
            className="icon-btn sm"
            title="Remove custom server"
            aria-label="Remove custom server"
            onClick={onRemove}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {keyed && server.requiresSecret && (
        <McpKeyField
          serverId={server.id}
          requirement={server.requiresSecret}
          stored={stored}
          hint={hint}
          envPresent={envPresent}
          onChanged={onSecretChanged}
          testable={testable}
        />
      )}
    </div>
  );
}

function McpHarnessBadges({ server }: { server: McpServerEntry }) {
  return (
    <span className="mcp-harness-badges">
      <span className={`mcp-badge ${server.harnessSupport.claude ? 'live' : 'off'}`}>
        Claude{server.harnessSupport.claude ? ' ✓' : ' —'}
      </span>
      <span className="mcp-badge soon">Codex · v2</span>
      <span className="mcp-badge soon">Pi · plugin</span>
    </span>
  );
}

function statusChip(
  enabled: boolean,
  keyed: boolean,
  stored: boolean,
  envPresent: boolean,
): { label: string; cls: string } {
  if (!enabled) return { label: 'Off', cls: 'off' };
  if (!keyed) return { label: 'On', cls: 'on' };
  if (stored) return { label: 'On · key set', cls: 'on' };
  if (envPresent) return { label: 'On · using env', cls: 'on' };
  return { label: 'On · needs key', cls: 'warn' };
}
