import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import type { PiProvider } from '../../api';
import { PiEndpointAdvanced } from './PiEndpointAdvanced';

type Props = {
  endpoint: PiProvider;
  probing: boolean;
  detectedIds: string[];
  probeError?: string;
  advancedOpen: boolean;
  onPatch: (partial: Partial<PiProvider>) => void;
  onRemove: () => void;
  onDetect: () => void;
  onToggleModel: (modelId: string) => void;
  onToggleAdvanced: () => void;
  onUpdateCompat: (key: string, value: string | boolean | undefined) => void;
  onUpdateHeaderKey: (rowIdx: number, key: string) => void;
  onUpdateHeaderValue: (rowIdx: number, value: string) => void;
  onAddHeader: () => void;
  onRemoveHeader: (rowIdx: number) => void;
};

// One managed Pi endpoint: id / baseUrl, optional api key + "Detect models",
// the model checklist, and the collapsible Advanced (compat / headers) section.
// All mutators are pre-bound to this endpoint's index by the parent tab.
export function PiEndpointCard({
  endpoint,
  probing,
  detectedIds,
  probeError,
  advancedOpen,
  onPatch,
  onRemove,
  onDetect,
  onToggleModel,
  onToggleAdvanced,
  onUpdateCompat,
  onUpdateHeaderKey,
  onUpdateHeaderValue,
  onAddHeader,
  onRemoveHeader,
}: Props) {
  const modelIds = new Set(endpoint.models.map((m) => m.id));
  // Show detected ids plus any already on the provider (e.g. loaded).
  const shownIds = [
    ...new Set([...detectedIds, ...endpoint.models.map((m) => m.id)]),
  ];
  return (
    <div className="settings-pi-endpoint">
      <div className="settings-pi-endpoint-head">
        <input
          className="text-input"
          style={{ width: 130 }}
          placeholder="provider id"
          value={endpoint.id}
          onChange={(e) => onPatch({ id: e.target.value })}
        />
        <input
          className="text-input"
          style={{ flex: 1, minWidth: 160 }}
          placeholder="https://host:port/v1"
          value={endpoint.baseUrl}
          onChange={(e) => onPatch({ baseUrl: e.target.value })}
        />
        <button
          className="icon-btn sm"
          onClick={onRemove}
          title="Remove endpoint"
          aria-label="Remove endpoint"
        >
          <X size={12} />
        </button>
      </div>
      <div className="settings-pi-endpoint-head">
        <input
          className="text-input"
          style={{ width: 130 }}
          placeholder="api key (optional)"
          value={endpoint.apiKey ?? ''}
          onChange={(e) => onPatch({ apiKey: e.target.value })}
        />
        <button
          className="btn-ghost"
          onClick={onDetect}
          disabled={probing}
          title="Query <baseUrl>/models and list what the server offers"
        >
          <RefreshCw size={11} />
          {probing ? 'Detecting…' : 'Detect models'}
        </button>
      </div>
      {probeError && (
        <div className="error-msg" style={{ marginTop: 4 }}>
          {probeError}
        </div>
      )}
      {shownIds.length > 0 && (
        <div className="settings-checkbox-list" style={{ maxHeight: 140 }}>
          {shownIds.map((id) => (
            <label key={id} className="settings-checkbox-row">
              <input
                type="checkbox"
                checked={modelIds.has(id)}
                onChange={() => onToggleModel(id)}
              />
              <span>{id}</span>
            </label>
          ))}
        </div>
      )}

      <button
        type="button"
        className="btn-ghost settings-pi-advanced-toggle"
        onClick={onToggleAdvanced}
      >
        {advancedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Advanced (thinking format / headers)
      </button>
      {advancedOpen && (
        <PiEndpointAdvanced
          endpoint={endpoint}
          onUpdateCompat={onUpdateCompat}
          onUpdateHeaderKey={onUpdateHeaderKey}
          onUpdateHeaderValue={onUpdateHeaderValue}
          onAddHeader={onAddHeader}
          onRemoveHeader={onRemoveHeader}
        />
      )}
    </div>
  );
}
