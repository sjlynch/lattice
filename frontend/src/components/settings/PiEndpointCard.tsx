import { ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import type { PiProbeModel, PiProvider } from '../../api';
import { PiEndpointAdvanced } from './PiEndpointAdvanced';
import {
  extendedThinkingLevels,
  formatContextWindow,
  isAggregatorEndpoint,
  shownEndpointModels,
} from './piTabUtils';

type Props = {
  endpoint: PiProvider;
  probing: boolean;
  detectedModels: PiProbeModel[];
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
  detectedModels,
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
  const autoDiscover = endpoint.autoDiscover !== false;
  const aggregator = isAggregatorEndpoint(endpoint);
  const modelIds = new Set(endpoint.models.map((m) => m.id));
  // Detected models plus any already on the provider (e.g. loaded from a
  // previous save), each with the best context window known for it.
  const shown = shownEndpointModels(endpoint, detectedModels);
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
          {probing ? 'Detecting…' : autoDiscover ? 'Refresh now' : 'Detect models'}
        </button>
      </div>
      <label
        className="settings-checkbox-row"
        title={
          'Keep this endpoint\u2019s model list matching whatever it is serving. ' +
          'Lattice re-checks on save, on startup, and whenever a harness ' +
          'dropdown opens \u2014 so restarting the server on a different model ' +
          'just works. Turn off to pick the models by hand.'
        }
      >
        <input
          type="checkbox"
          checked={autoDiscover}
          onChange={(e) => onPatch({ autoDiscover: e.target.checked })}
        />
        <span>Auto-discover models</span>
      </label>
      {probeError && (
        <div className="error-msg" style={{ marginTop: 4 }}>
          {probeError}
        </div>
      )}
      {shown.length === 0 && autoDiscover && !!endpoint.baseUrl.trim() && !probeError && (
        <div className="settings-section-sub" style={{ opacity: 0.7 }}>
          No models yet — they appear once Lattice reaches the endpoint.
        </div>
      )}
      {shown.length > 0 && autoDiscover && (
        <div className="settings-section-sub" style={{ opacity: 0.7 }}>
          {aggregator
            ? `${endpoint.models.length} models served — too many to list in the ` +
              'harness dropdowns, so pick the ones you want in “Pi model menu” below.'
            : 'Served right now (kept in sync automatically):'}
        </div>
      )}
      {shown.length > 0 && (
        <div className="settings-checkbox-list" style={{ maxHeight: 140 }}>
          {shown.map(({ id, contextWindow, thinkingLevels }) => (
            <label key={id} className="settings-checkbox-row">
              <input
                type="checkbox"
                checked={modelIds.has(id)}
                // While auto-discovering, the list mirrors the server — hand
                // un-ticking a model would be undone by the next refresh, so
                // don't offer a control that can't hold.
                disabled={autoDiscover}
                onChange={() => onToggleModel(id)}
              />
              <span>{id}</span>
              {extendedThinkingLevels(thinkingLevels).length > 0 && (
                <span
                  className="settings-pi-model-ctx"
                  title={
                    'This endpoint accepts extended reasoning levels, so Pi can ' +
                    'use them. Without this Pi silently clamps them to “high”. ' +
                    'Pick a level with /thinking inside a Pi session.'
                  }
                >
                  {extendedThinkingLevels(thinkingLevels).join(' · ')}
                </span>
              )}
              {contextWindow !== undefined && (
                <span
                  className="settings-pi-model-ctx"
                  title={`${contextWindow.toLocaleString()} token context window, reported by the endpoint`}
                >
                  {formatContextWindow(contextWindow)}
                </span>
              )}
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
        Advanced (API protocol / thinking format / headers)
      </button>
      {advancedOpen && (
        <PiEndpointAdvanced
          endpoint={endpoint}
          onUpdateApi={(api) => onPatch({ api: api || undefined })}
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
