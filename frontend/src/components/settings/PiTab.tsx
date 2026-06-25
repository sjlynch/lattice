import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { Plus } from 'lucide-react';
import {
  fetchGlobalSettings,
  getPiModels,
  type PiModelInfo,
  type PiProvider,
} from '../../api';
import { useEndpointState, useProbeDetection } from './usePiEndpoints';
import {
  collectModelUniverse,
  entriesToHeaders,
  sanitizeProvidersForSave,
} from './piTabUtils';
import { PiEndpointCard } from './PiEndpointCard';
import { PiModelMenu } from './PiModelMenu';
import { SettingsInfo } from './SettingsInfo';

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
// menu surfaced as "Pi — X" rows in the harness dropdowns. The endpoint card and
// model-menu UI live in focused components; this tab owns the draft state, the
// load, the edit handlers, and the imperative save-patch handle.
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

  const [savedModels, setSavedModels] = useState<PiModelInfo[]>([]);
  const [menuSelected, setMenuSelected] = useState<Set<string>>(new Set());
  const [menuTouched, setMenuTouched] = useState(false);
  // Which endpoints have their "Advanced" (compat / headers) section open.
  const [advancedOpen, setAdvancedOpen] = useState<Record<number, boolean>>({});
  // Patterns we've already reflected into menuSelected — so a newly-added
  // endpoint model defaults to shown, but a model the user later unchecks
  // doesn't get auto-re-added on the next render.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    endpoints.setTouched(false);
    setMenuTouched(false);
    probe.reset();
    fetchGlobalSettings()
      .then((s) => {
        if (!cancelled) endpoints.setProviders(s.piProviders ?? []);
      })
      .catch(() => { /* leave empty */ });
    getPiModels()
      .then((r) => {
        if (cancelled) return;
        setSavedModels(r.models);
        const seed = new Set(r.menu.map((m) => m.pattern));
        setMenuSelected(seed);
        seenRef.current = new Set(r.models.map((m) => m.pattern));
      })
      .catch(() => { /* leave empty */ });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The universe of selectable model patterns = saved models ∪ everything the
  // draft endpoints declare. Recomputed each render (cheap).
  const universe = collectModelUniverse(savedModels, providers);

  // Auto-include any newly-appeared pattern (a model just added to a draft
  // endpoint) in the menu, so it shows in the dropdowns by default.
  useEffect(() => {
    let changed = false;
    const next = new Set(menuSelected);
    for (const pattern of universe) {
      if (!seenRef.current.has(pattern)) {
        seenRef.current.add(pattern);
        next.add(pattern);
        changed = true;
      }
    }
    if (changed) setMenuSelected(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, savedModels]);

  useImperativeHandle(
    ref,
    () => ({
      getPiProvidersPatch: () => {
        if (!endpoints.touched) return undefined;
        return sanitizeProvidersForSave(providers);
      },
      getPiModelMenuPatch: () => {
        if (!endpoints.touched && !menuTouched) return undefined;
        return [...menuSelected].filter((p) => universe.has(p));
      },
    }),
    // universe / providers / menuSelected are all derived from the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoints.touched, menuTouched, providers, menuSelected, savedModels],
  );

  if (!active) return null;

  const patchProvider = endpoints.patch;
  const addProvider = endpoints.add;
  const removeProvider = endpoints.remove;

  // Set/clear a single `compat` key (empty/undefined removes it; the whole
  // compat object is dropped once it's empty so we don't write `compat: {}`).
  const updateCompat = (
    idx: number,
    key: string,
    value: string | boolean | undefined,
  ) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) => {
        if (i !== idx) return p;
        const compat: Record<string, unknown> = { ...(p.compat ?? {}) };
        if (value === undefined || value === '') delete compat[key];
        else compat[key] = value;
        const next = { ...p };
        if (Object.keys(compat).length) next.compat = compat;
        else delete next.compat;
        return next;
      }),
    );
  };

  const setHeaderEntries = (idx: number, entries: [string, string][]) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) =>
        i === idx ? { ...p, headers: entriesToHeaders(entries) } : p,
      ),
    );
  };

  // Read endpoint `idx`'s header rows as ordered entries, let `fn` mutate them
  // in place, then write the result back — the shared body of the four header
  // mutators below.
  const mutateHeaderEntries = (
    idx: number,
    fn: (entries: [string, string][]) => void,
  ) => {
    const entries = Object.entries(providers[idx]?.headers ?? {});
    fn(entries);
    setHeaderEntries(idx, entries);
  };

  const updateHeaderKey = (idx: number, rowIdx: number, key: string) =>
    mutateHeaderEntries(idx, (entries) => {
      if (entries[rowIdx]) entries[rowIdx] = [key, entries[rowIdx][1]];
    });

  const updateHeaderValue = (idx: number, rowIdx: number, value: string) =>
    mutateHeaderEntries(idx, (entries) => {
      if (entries[rowIdx]) entries[rowIdx] = [entries[rowIdx][0], value];
    });

  const addHeader = (idx: number) =>
    mutateHeaderEntries(idx, (entries) => {
      // Unique placeholder key so a second "add" never collides with a blank one.
      entries.push([`header-${entries.length + 1}`, '']);
    });

  const removeHeader = (idx: number, rowIdx: number) =>
    mutateHeaderEntries(idx, (entries) => {
      entries.splice(rowIdx, 1);
    });

  const toggleEndpointModel = (idx: number, modelId: string) => {
    endpoints.mutate((cur) =>
      cur.map((p, i) => {
        if (i !== idx) return p;
        const has = p.models.some((m) => m.id === modelId);
        return {
          ...p,
          models: has
            ? p.models.filter((m) => m.id !== modelId)
            : [...p.models, { id: modelId }],
        };
      }),
    );
  };

  const detectModels = (idx: number) =>
    probe.detect(idx, providers[idx], (ids) =>
      endpoints.mutate((cur) =>
        cur.map((p, i) =>
          i === idx
            ? {
                ...p,
                models: ids.map(
                  (id) => p.models.find((m) => m.id === id) ?? { id },
                ),
              }
            : p,
        ),
      ),
    );

  const toggleMenu = (pattern: string) => {
    setMenuTouched(true);
    setMenuSelected((cur) => {
      const next = new Set(cur);
      if (next.has(pattern)) next.delete(pattern);
      else next.add(pattern);
      return next;
    });
  };

  const menuPatterns = [...universe].sort();

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
                  The API key may be a literal, an environment variable name, or
                  a <code>!command</code> — Pi resolves it.
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
            key={idx}
            endpoint={ep}
            probing={!!probing[idx]}
            detectedIds={detected[idx] ?? []}
            probeError={probeError[idx]}
            advancedOpen={!!advancedOpen[idx]}
            onPatch={(partial) => patchProvider(idx, partial)}
            onRemove={() => removeProvider(idx)}
            onDetect={() => void detectModels(idx)}
            onToggleModel={(modelId) => toggleEndpointModel(idx, modelId)}
            onToggleAdvanced={() =>
              setAdvancedOpen((o) => ({ ...o, [idx]: !o[idx] }))
            }
            onUpdateCompat={(key, value) => updateCompat(idx, key, value)}
            onUpdateHeaderKey={(rowIdx, key) => updateHeaderKey(idx, rowIdx, key)}
            onUpdateHeaderValue={(rowIdx, value) =>
              updateHeaderValue(idx, rowIdx, value)
            }
            onAddHeader={() => addHeader(idx)}
            onRemoveHeader={(rowIdx) => removeHeader(idx, rowIdx)}
          />
        ))}

        <button className="btn-ghost" onClick={addProvider} style={{ marginTop: 8 }}>
          <Plus size={12} />
          Add endpoint
        </button>
      </div>

      <PiModelMenu
        patterns={menuPatterns}
        selected={menuSelected}
        onToggle={toggleMenu}
      />
    </>
  );
});
