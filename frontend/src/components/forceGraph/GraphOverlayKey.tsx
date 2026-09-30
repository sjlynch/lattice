import { memo } from 'react';
import type { OverlayPinKey, OverlayPins } from './hooks/useOverlayPins';
import type { SecurityOverlayControl } from './hooks/useSecurityOverlay';
import { SECURITY_COLORS } from './securityOverlay';

type OverlayDef = {
  key: OverlayPinKey;
  label: string;
  // Display name for the hold-key shortcut.
  shortcut: string;
};

// Order mirrors the recolor precedence + the order documented in the project
// CLAUDE.md (H/Z/D/W/Alt).
const OVERLAYS: OverlayDef[] = [
  { key: 'health', label: 'Health', shortcut: 'H' },
  { key: 'loc', label: 'LOC', shortcut: 'Z' },
  { key: 'dead', label: 'Dead', shortcut: 'D' },
  { key: 'worktree', label: 'Worktree', shortcut: 'W' },
  { key: 'labels', label: 'Labels', shortcut: 'Alt' },
];

type Props = {
  // Which views are pinned (latched on without holding the key).
  pinned: OverlayPins;
  // Which views are currently *showing* (held OR pinned) — drives the lit
  // "active" chip state so holding a key also highlights its chip.
  active: OverlayPins;
  onTogglePin: (key: OverlayPinKey) => void;
  security: SecurityOverlayControl;
};

// Always-visible key for the graph's hold-key overlays (top-left). Each chip
// documents a view + its shortcut and, when clicked, PINS that view so it
// persists without holding the key (click again to unpin). Turns the otherwise
// invisible Z/D/W/Alt power-features into discoverable, latchable tools.
export const GraphOverlayKey = memo(function GraphOverlayKey({
  pinned,
  active,
  onTogglePin,
  security,
}: Props) {
  return (
    <div className="graph-overlay-key" role="group" aria-label="Graph view overlays">
      {OVERLAYS.map((o) => {
        const isPinned = pinned[o.key];
        const isActive = active[o.key];
        const cls = `graph-overlay-chip${isActive ? ' is-active' : ''}${
          isPinned ? ' is-pinned' : ''
        }`;
        return (
          <button
            key={o.key}
            type="button"
            className={cls}
            aria-pressed={isPinned}
            title={
              isPinned
                ? `${o.label} view pinned — click to unpin (or hold ${o.shortcut})`
                : `Show ${o.label} view — click to pin, or hold ${o.shortcut}`
            }
            onClick={() => onTogglePin(o.key)}
          >
            <span className="graph-overlay-chip-label">{o.label}</span>
            <kbd className="graph-overlay-chip-key">{o.shortcut}</kbd>
          </button>
        );
      })}
      {security.available && (
        <button
          type="button"
          className={`graph-overlay-chip${security.active ? ' is-active is-pinned' : ''}`}
          aria-pressed={security.active}
          aria-busy={security.scanning}
          disabled={security.scanning}
          title={security.scanning ? 'Scanning for security issues…' : security.active
            ? 'Hide Security view. Turn it on again to run a fresh scan.'
            : 'Scan this project with OpenGrep and color files by severity'}
          onClick={() => void security.onToggle()}
        >
          {security.scanning && <span className="spinner graph-security-spinner" aria-hidden="true" />}
          <span className="graph-overlay-chip-label">Security</span>
          {security.active && security.result && (
            <span className="graph-overlay-chip-key">{(security.result.scan.durationMs / 1000).toFixed(1)}s</span>
          )}
        </button>
      )}
      {security.available && security.active && security.result && (
        <div className="graph-security-legend" role="status" title="Uses the severity and ignore filters in Settings → Tools. Green means scanned with no findings after those filters.">
          <span>{security.result.shown} findings</span>
          <span style={{ color: SECURITY_COLORS.ERROR }}>ERROR</span>
          <span style={{ color: SECURITY_COLORS.WARNING }}>WARNING</span>
          <span style={{ color: SECURITY_COLORS.INFO }}>INFO</span>
          <span style={{ color: SECURITY_COLORS.clear }}>No shown findings</span>
          <span>Gray: unscanned / incomplete</span>
        </div>
      )}
      {security.available && security.error && <span className="graph-security-message" role="alert">{security.error}</span>}
    </div>
  );
});
