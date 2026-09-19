import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  fetchGlobalSettings,
  type PiProvider,
} from '../../api';
import {
  useEndpointState,
  useProbeDetection,
  usePiEndpointEditors,
} from './usePiEndpoints';
import {
  alwaysShownPatterns,
  dropEndpointKey,
  sanitizeProvidersForSave,
} from './piTabUtils';
import { PiEndpointCard } from './PiEndpointCard';
import { PiModelMenu } from './PiModelMenu';
import { SettingsInfo } from './SettingsInfo';
import { usePiModelMenuDraft } from './usePiModelMenuDraft';

type Props = {
  active: boolean;
  open: boolean;
};

export type PiTabHandle = {
  // The Pi providers to persist (reconciled into models.json), or `undefined`
  // when untouched. Same clobber-guard contract as the other tabs.
  getPiProvidersPatch: () => PiProvider[] | undefined;
  // The curated Pi model menu (provider/model patterns), or `undefined`.
  // Persisted whenever providers OR the menu were touched, since adding an
  // endpoint should make its models appear in the dropdowns.
  getPiModelMenuPatch: () => string[] | undefined;
};

// Machine-global Pi configuration: OpenAI-compatible endpoints (vLLM, etc.)
// that Lattice reconciles into ~/.pi/agent/models.json, plus the curated model
// menu surfaced as "Pi — X" rows in the harness dropdowns. Focused hooks own the
// endpoint editors and model-menu draft; this tab coordinates loading, transient
// card state, rendering, and the imperative save-patch handle.
export const PiTab = forwardRef<PiTabHandle, Props>(function PiTab(
  { active, open },
  ref,
) {
  // The endpoint list + touched flag + patch/add/remove, and the per-endpoint
  // probe state + "Detect models" flow, each live in a focused hook.
  const endpoints = useEndpointState();
  const probe = useProbeDetection();
  const { providers } = endpoints;
  const { probing, detected, probeError } = probe;
  // The per-endpoint field editors (compat / headers / model checklist /
  // detect). Index-bound by the render below; provider mutations flow through
  // `endpoints.mutate`.
  const editors = usePiEndpointEditors(endpoints, probe, providers);

  const modelMenu = usePiModelMenuDraft(open, providers);
  // Which endpoints have their "Advanced" (compat / headers) section open —
  // keyed by the endpoint's stable id (not its array index) so removing an
  // earlier endpoint can't shift the Advanced section onto a different card.
  const [advancedOpen, setAdvancedOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    endpoints.setTouched(false);
    probe.reset();
    fetchGlobalSettings()
      .then((s) => {
        if (cancelled) return;
        const loaded = s.piProviders ?? [];
        endpoints.setProviders(loaded);
        // Saved models are part of the checklist's universe, not just its
        // selection — see useProbeDetection.seed.
        probe.seed(loaded);
      })
      .catch(() => { /* leave empty */ });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useImperativeHandle(
    ref,
    () => ({
      getPiProvidersPatch: () => {
        if (!endpoints.touched) return undefined;
        return sanitizeProvidersForSave(providers);
      },
      getPiModelMenuPatch: () => modelMenu.getPatch(endpoints.touched),
    }),
    [endpoints.touched, modelMenu, providers],
  );

  if (!active) return null;

  const patchProvider = endpoints.patch;
  const addProvider = endpoints.add;

  // Remove an endpoint and forget its id-keyed transient state (probe results /
  // Advanced toggle) so a survivor never inherits it.
  const removeEndpoint = (idx: number, id: string) => {
    endpoints.remove(idx);
    probe.dropEndpoint(id);
    setAdvancedOpen((o) => dropEndpointKey(o, id));
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title-row">
              <div className="settings-section-title">Pi endpoints</div>
              <SettingsInfo label="About Pi endpoints">
                <p>
                  Saving reconciles these endpoints into{' '}
                  <code>~/.pi/agent/models.json</code>. Your hand-written
                  providers there are preserved; Pi’s defaults in{' '}
                  <code>settings.json</code> are never touched.
                </p>
                <p>
                  The API key may be a literal, <code>$VAR</code> /{' '}
                  <code>{'${VAR}'}</code> environment interpolation, or a{' '}
                  <code>!command</code> — Pi resolves all three (a bare{' '}
                  <code>MY_API_KEY</code> is a literal). “Detect models” and
                  auto-discovery resolve none of them, so an endpoint using the{' '}
                  <code>$VAR</code> or <code>!command</code> form can’t be probed
                  from here.
                </p>
              </SettingsInfo>
            </div>
            <div className="settings-section-sub">
              OpenAI-compatible model servers (e.g. a local vLLM box) Lattice
              manages for Pi.
            </div>
          </div>
        </div>

        {providers.length === 0 && (
          <div className="settings-section-sub" style={{ opacity: 0.7 }}>
            No managed endpoints. Add one to expose its models as “Pi — …”
            options.
          </div>
        )}

        {providers.map((ep, idx) => (
          <PiEndpointCard
            key={ep.id}
            endpoint={ep}
            probing={!!probing[ep.id]}
            detectedModels={detected[ep.id] ?? []}
            probeError={probeError[ep.id]}
            advancedOpen={!!advancedOpen[ep.id]}
            onPatch={(partial) => patchProvider(idx, partial)}
            onRemove={() => removeEndpoint(idx, ep.id)}
            onDetect={() => void editors.detectModels(idx)}
            onToggleModel={(modelId) => editors.toggleEndpointModel(idx, modelId)}
            onToggleAdvanced={() =>
              setAdvancedOpen((o) => ({ ...o, [ep.id]: !o[ep.id] }))
            }
            onUpdateCompat={(key, value) => editors.updateCompat(idx, key, value)}
            onUpdateHeaderKey={(rowIdx, key) =>
              editors.updateHeaderKey(idx, rowIdx, key)
            }
            onUpdateHeaderValue={(rowIdx, value) =>
              editors.updateHeaderValue(idx, rowIdx, value)
            }
            onAddHeader={() => editors.addHeader(idx)}
            onRemoveHeader={(rowIdx) => editors.removeHeader(idx, rowIdx)}
          />
        ))}

        <button className="btn-ghost" onClick={addProvider} style={{ marginTop: 8 }}>
          <Plus size={12} />
          Add endpoint
        </button>
      </div>

      <PiModelMenu
        patterns={modelMenu.patterns}
        selected={modelMenu.selected}
        alwaysShown={alwaysShownPatterns(providers, modelMenu.patterns)}
        onToggle={modelMenu.toggle}
      />
    </>
  );
});
