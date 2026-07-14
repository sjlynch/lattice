import { Eye, EyeOff, Trash2 } from 'lucide-react';
import type { McpServerEntry } from '../../../api';
import {
  HARNESS_LABELS,
  type AgentHarness,
  type HarnessAvailability,
} from '../../../harnesses';
import { McpKeyField } from './McpKeyField';

// Render order for the per-harness toggles. Matches the harness dropdowns
// (`buildHarnessOptions`: Claude, Codex, Pi) rather than the internal
// ALL_AGENT_HARNESSES order (claude, pi, codex), so the UI reads consistently.
const HARNESS_TOGGLE_ORDER: readonly AgentHarness[] = ['claude', 'codex', 'pi'];

type Props = {
  server: McpServerEntry;
  // Per-harness enable state + setter. Claude persists via `mcpOverrides`;
  // Codex/Pi via `mcpHarnessOverrides` (three independent switches per server).
  enabledFor: (harness: AgentHarness) => boolean;
  onToggle: (harness: AgentHarness, next: boolean) => void;
  // Which harness CLIs are on PATH — an un-detected harness's toggle is greyed.
  harnessAvail: HarnessAvailability;
  // Playwright's Claude toggle is the GLOBAL enable (mcpOverrides). The hint
  // clarifies that the QA lane has a separate, QA-runs-only toggle.
  playwrightHint?: boolean;
  // Playwright-only cross-harness headed/headless switch (`mcpPlaywrightHeaded`).
  // `undefined` for every other row (the control is hidden). When on, Lattice
  // launches the Playwright browser HEADED (visible) so the user can watch a
  // session drive it; off = headless. `onHeadedChange` present ⇒ render it.
  headed?: boolean;
  onHeadedChange?: (next: boolean) => void;
  // Secret state for a requiresSecret server (shared across all three harnesses).
  stored: boolean;
  hint?: string;
  envPresent: boolean;
  onSecretChanged: () => void;
  testable: boolean;
  // Custom (non-built-in) servers can be removed.
  onRemove?: () => void;
};

// One catalog row: three per-harness enable toggles, label + description,
// runtime caveat, the §8 status chip, and (for keyed servers) the inline key
// field. A server is "on" (highlighted) when enabled for at least one harness.
export function McpServerRow({
  server,
  enabledFor,
  onToggle,
  harnessAvail,
  playwrightHint,
  headed,
  onHeadedChange,
  stored,
  hint,
  envPresent,
  onSecretChanged,
  testable,
  onRemove,
}: Props) {
  const keyed = !!server.requiresSecret;
  const anyEnabled = HARNESS_TOGGLE_ORDER.some((h) => enabledFor(h));
  const chip = statusChip(anyEnabled, keyed, stored, envPresent);

  return (
    <div className={`mcp-row ${anyEnabled ? 'on' : ''}`}>
      <div className="mcp-row-main">
        <div className="mcp-row-text">
          <div className="mcp-row-title">
            {server.label}
            <span className={`mcp-chip ${chip.cls}`}>{chip.label}</span>
            {!server.builtin && <span className="mcp-chip custom">Custom</span>}
          </div>
          <div className="mcp-row-desc">{server.description}</div>
          <div className="mcp-row-meta">
            <div className="mcp-harness-toggles">
              {HARNESS_TOGGLE_ORDER.map((h) => (
                <HarnessToggle
                  key={h}
                  harness={h}
                  supported={server.harnessSupport[h] === true}
                  available={harnessAvail[h] !== false}
                  enabled={enabledFor(h)}
                  onToggle={(next) => onToggle(h, next)}
                />
              ))}
              {onHeadedChange && (
                <HeadedToggle
                  headed={headed === true}
                  onChange={onHeadedChange}
                />
              )}
            </div>
            {server.runtimeNote && (
              <span className="mcp-runtime-note">⚠ {server.runtimeNote}</span>
            )}
            {playwrightHint && (
              <span className="mcp-runtime-note">
                Claude's toggle is global (every Claude session Lattice runs in
                this project, plus your own <code>claude</code> at the project
                root); Codex/Pi are per-harness. The browser runs{' '}
                <strong>headless</strong> unless you turn on{' '}
                <strong>Show browser</strong> — flip that on when you want to{' '}
                <em>watch</em> a session drive it. (The QA lane keeps its own
                separate headed/headless eye switch for QA runs.)
              </span>
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

// A single labeled per-harness switch. Disabled (greyed, with an explanatory
// tooltip) when the server doesn't support the harness or the harness CLI isn't
// on PATH.
function HarnessToggle({
  harness,
  supported,
  available,
  enabled,
  onToggle,
}: {
  harness: AgentHarness;
  supported: boolean;
  available: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const label = HARNESS_LABELS[harness];
  const disabled = !supported || !available;
  const title = !supported
    ? `${label} isn't supported for this server`
    : !available
      ? `${label} CLI isn't detected on PATH`
      : enabled
        ? `Enabled for ${label}`
        : `Disabled for ${label}`;
  return (
    <label
      className={`mcp-harness-toggle ${disabled ? 'is-disabled' : ''}`}
      title={title}
    >
      <input
        type="checkbox"
        checked={enabled && supported}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
      />
      <span className="mcp-toggle-track" />
      <span className="mcp-harness-toggle-label">{label}</span>
    </label>
  );
}

// Playwright-only headed/headless switch. Sits alongside the per-harness
// toggles but is cross-harness — one control for the whole Playwright row,
// mirroring the QA lane's eye switch. On = a visible browser window.
function HeadedToggle({
  headed,
  onChange,
}: {
  headed: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className="mcp-harness-toggle mcp-headed-toggle"
      title={
        headed
          ? 'Playwright runs headed — a browser window is shown so you can watch it'
          : 'Playwright runs headless — no visible browser window'
      }
    >
      <input
        type="checkbox"
        checked={headed}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="mcp-toggle-track" />
      <span className="mcp-harness-toggle-label">
        {headed ? <Eye size={12} /> : <EyeOff size={12} />} Show browser
      </span>
    </label>
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
