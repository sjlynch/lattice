import { Plus, X } from 'lucide-react';
import type { PiProvider } from '../../api';
import { compatString } from './piTabUtils';

type Props = {
  endpoint: PiProvider;
  onUpdateCompat: (key: string, value: string | boolean | undefined) => void;
  onUpdateHeaderKey: (rowIdx: number, key: string) => void;
  onUpdateHeaderValue: (rowIdx: number, value: string) => void;
  onAddHeader: () => void;
  onRemoveHeader: (rowIdx: number) => void;
};

// The per-endpoint "Advanced" section: compat thinking-format + developer-role
// support, and custom request headers. Callbacks are pre-bound to this
// endpoint's index by the parent card.
export function PiEndpointAdvanced({
  endpoint,
  onUpdateCompat,
  onUpdateHeaderKey,
  onUpdateHeaderValue,
  onAddHeader,
  onRemoveHeader,
}: Props) {
  return (
    <div className="settings-pi-advanced">
      <label className="settings-pi-advanced-field">
        <span>Thinking format</span>
        <input
          className="text-input"
          placeholder="e.g. qwen-chat-template (optional)"
          value={compatString(endpoint.compat, 'thinkingFormat')}
          onChange={(e) => onUpdateCompat('thinkingFormat', e.target.value)}
        />
      </label>
      <label className="settings-checkbox-row">
        <input
          type="checkbox"
          checked={endpoint.compat?.supportsDeveloperRole !== false}
          onChange={(e) =>
            onUpdateCompat(
              'supportsDeveloperRole',
              e.target.checked ? undefined : false,
            )
          }
        />
        <span>Server supports the developer role</span>
      </label>
      <div className="settings-pi-advanced-headers">
        <div className="settings-section-sub">Custom request headers</div>
        {Object.entries(endpoint.headers ?? {}).map(([k, v], rowIdx) => (
          <div key={rowIdx} className="settings-pi-endpoint-head">
            <input
              className="text-input"
              style={{ width: 130 }}
              placeholder="Header-Name"
              value={k}
              onChange={(e) => onUpdateHeaderKey(rowIdx, e.target.value)}
            />
            <input
              className="text-input"
              style={{ flex: 1, minWidth: 120 }}
              placeholder="value"
              value={v}
              onChange={(e) => onUpdateHeaderValue(rowIdx, e.target.value)}
            />
            <button
              className="icon-btn sm"
              onClick={() => onRemoveHeader(rowIdx)}
              title="Remove header"
              aria-label="Remove header"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="btn-ghost" onClick={onAddHeader}>
          <Plus size={12} />
          Add header
        </button>
      </div>
    </div>
  );
}
