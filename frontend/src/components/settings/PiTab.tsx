import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { ChevronDown, ChevronRight, Plus, RefreshCw, X } from 'lucide-react';
import {
  fetchGlobalSettings,
  getPiModels,
  probePiEndpoint,
  type PiModelInfo,
  type PiProvider,
} from '../../api';

type Props = {
  active: boolean;
  open: boolean;
};

// Drop blank/whitespace header keys and omit the map entirely when empty, so a
// half-typed header row never reaches models.json.
function cleanHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.trim();
    if (key) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

// Rebuild a header record from ordered [key,value] pairs. fromEntries keeps
// insertion order (so editing a key in place doesn't reshuffle rows) and a
// transient empty/duplicate key just collapses — fine mid-edit.
function entriesToHeaders(entries: [string, string][]): Record<string, string> {
  return Object.fromEntries(entries);
}

// Read a string-valued compat key for an input value.
function compatString(
  compat: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = compat?.[key];
  return typeof v === 'string' ? v : '';
}

export type PiTabHandle = {
  // The Pi providers to persist (reconciled into models.json), or `undefined`
  // when untouched. Same clobber-guard contract as the other tabs.
  getPiProvidersPatch: () => PiProvider[] | undefined;
  // The curated Pi model menu (provider/model patterns), or `undefined`.
  // Persisted whenever providers OR the menu were touched, since adding an
  // endpoint should make its models appear in the dropdowns.
  getPiModelMenuPatch: () => string[] | undefined;
};

// A blank provider row.
function blankProvider(seq: number): PiProvider {
  return { id: `endpoint-${seq}`, baseUrl: '', models: [] };
}

// Machine-global Pi configuration: OpenAI-compatible endpoints (vLLM, etc.)
// that Lattice reconciles into ~/.pi/agent/models.json, plus the curated model
// menu surfaced as "Pi — X" rows in the harness dropdowns.
export const PiTab = forwardRef<PiTabHandle, Props>(function PiTab(
  { active, open },
  ref,
) {
  const [providers, setProviders] = useState<PiProvider[]>([]);
  const [providersTouched, setProvidersTouched] = useState(false);
  const [savedModels, setSavedModels] = useState<PiModelInfo[]>([]);
  const [menuSelected, setMenuSelected] = useState<Set<string>>(new Set());
  const [menuTouched, setMenuTouched] = useState(false);
  // Per-endpoint "Detect models" transient state, keyed by row index.
  const [probing, setProbing] = useState<Record<number, boolean>>({});
  const [detected, setDetected] = useState<Record<number, string[]>>({});
  const [probeError, setProbeError] = useState<Record<number, string>>({});
  // Which endpoints have their "Advanced" (compat / headers) section open.
  const [advancedOpen, setAdvancedOpen] = useState<Record<number, boolean>>({});
  const seqRef = useRef(0);
  // Patterns we've already reflected into menuSelected — so a newly-added
  // endpoint model defaults to shown, but a model the user later unchecks
  // doesn't get auto-re-added on the next render.
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProvidersTouched(false);
    setMenuTouched(false);
    setProbing({});
    setDetected({});
    setProbeError({});
    fetchGlobalSettings()
      .then((s) => {
        if (!cancelled) setProviders(s.piProviders ?? []);
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
  }, [open]);

  // The universe of selectable model patterns = saved models ∪ everything the
  // draft endpoints declare. Recomputed each render (cheap).
  const universe = new Set<string>(savedModels.map((m) => m.pattern));
  for (const p of providers) {
    for (const m of p.models) {
      if (p.id && m.id) universe.add(`${p.id}/${m.id}`);
    }
  }

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
        if (!providersTouched) return undefined;
        // Drop incomplete rows (need an id + baseUrl) so a half-typed endpoint
        // isn't written to models.json; clean half-typed header rows too.
        return providers
          .map((p) => {
            const headers = cleanHeaders(p.headers);
            return {
              ...p,
              id: p.id.trim(),
              baseUrl: p.baseUrl.trim(),
              models: p.models.filter((m) => m.id.trim()),
              headers,
            };
          })
          .filter((p) => p.id && p.baseUrl);
      },
      getPiModelMenuPatch: () => {
        if (!providersTouched && !menuTouched) return undefined;
        return [...menuSelected].filter((p) => universe.has(p));
      },
    }),
    // universe / providers / menuSelected are all derived from the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providersTouched, menuTouched, providers, menuSelected, savedModels],
  );

  if (!active) return null;

  const patchProvider = (idx: number, patch: Partial<PiProvider>) => {
    setProvidersTouched(true);
    setProviders((cur) => cur.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  };

  const addProvider = () => {
    setProvidersTouched(true);
    setProviders((cur) => [...cur, blankProvider(++seqRef.current)]);
  };

  const removeProvider = (idx: number) => {
    setProvidersTouched(true);
    setProviders((cur) => cur.filter((_, i) => i !== idx));
  };

  // Set/clear a single `compat` key (empty/undefined removes it; the whole
  // compat object is dropped once it's empty so we don't write `compat: {}`).
  const updateCompat = (
    idx: number,
    key: string,
    value: string | boolean | undefined,
  ) => {
    setProvidersTouched(true);
    setProviders((cur) =>
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
    setProvidersTouched(true);
    setProviders((cur) =>
      cur.map((p, i) =>
        i === idx ? { ...p, headers: entriesToHeaders(entries) } : p,
      ),
    );
  };

  const updateHeaderKey = (idx: number, rowIdx: number, key: string) => {
    const entries = Object.entries(providers[idx]?.headers ?? {});
    if (entries[rowIdx]) entries[rowIdx] = [key, entries[rowIdx][1]];
    setHeaderEntries(idx, entries);
  };

  const updateHeaderValue = (idx: number, rowIdx: number, value: string) => {
    const entries = Object.entries(providers[idx]?.headers ?? {});
    if (entries[rowIdx]) entries[rowIdx] = [entries[rowIdx][0], value];
    setHeaderEntries(idx, entries);
  };

  const addHeader = (idx: number) => {
    const entries = Object.entries(providers[idx]?.headers ?? {});
    // Unique placeholder key so a second "add" never collides with a blank one.
    entries.push([`header-${entries.length + 1}`, '']);
    setHeaderEntries(idx, entries);
  };

  const removeHeader = (idx: number, rowIdx: number) => {
    const entries = Object.entries(providers[idx]?.headers ?? {});
    entries.splice(rowIdx, 1);
    setHeaderEntries(idx, entries);
  };

  const toggleEndpointModel = (idx: number, modelId: string) => {
    setProvidersTouched(true);
    setProviders((cur) =>
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

  const detectModels = async (idx: number) => {
    const ep = providers[idx];
    if (!ep?.baseUrl.trim()) {
      setProbeError((e) => ({ ...e, [idx]: 'Enter a base URL first.' }));
      return;
    }
    setProbing((p) => ({ ...p, [idx]: true }));
    setProbeError((e) => ({ ...e, [idx]: '' }));
    try {
      const ids = await probePiEndpoint(ep.baseUrl.trim(), ep.apiKey?.trim() || undefined);
      setDetected((d) => ({ ...d, [idx]: ids }));
      // Pre-select all detected models (the common case); the user can uncheck.
      setProvidersTouched(true);
      setProviders((cur) =>
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
      );
    } catch (err) {
      setProbeError((e) => ({ ...e, [idx]: (err as Error).message || 'Probe failed' }));
    } finally {
      setProbing((p) => ({ ...p, [idx]: false }));
    }
  };

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
            <div className="settings-section-title">Pi endpoints</div>
            <div className="settings-section-sub">
              OpenAI-compatible model servers (e.g. a local vLLM box) Lattice
              manages for Pi. Saving reconciles these into{' '}
              <code>~/.pi/agent/models.json</code> (your hand-written providers
              there are preserved; Pi’s defaults in <code>settings.json</code>{' '}
              are never touched). The API key may be a literal, an environment
              variable name, or a <code>!command</code> — Pi resolves it.
            </div>
          </div>
        </div>

        {providers.length === 0 && (
          <div className="settings-section-sub" style={{ opacity: 0.7 }}>
            No managed endpoints. Add one to expose its models as “Pi — …”
            options.
          </div>
        )}

        {providers.map((ep, idx) => {
          const modelIds = new Set(ep.models.map((m) => m.id));
          const detectedIds = detected[idx] ?? [];
          // Show detected ids plus any already on the provider (e.g. loaded).
          const shownIds = [...new Set([...detectedIds, ...ep.models.map((m) => m.id)])];
          return (
            <div key={idx} className="settings-pi-endpoint">
              <div className="settings-pi-endpoint-head">
                <input
                  className="text-input"
                  style={{ width: 130 }}
                  placeholder="provider id"
                  value={ep.id}
                  onChange={(e) => patchProvider(idx, { id: e.target.value })}
                />
                <input
                  className="text-input"
                  style={{ flex: 1, minWidth: 160 }}
                  placeholder="https://host:port/v1"
                  value={ep.baseUrl}
                  onChange={(e) => patchProvider(idx, { baseUrl: e.target.value })}
                />
                <button
                  className="icon-btn sm"
                  onClick={() => removeProvider(idx)}
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
                  value={ep.apiKey ?? ''}
                  onChange={(e) => patchProvider(idx, { apiKey: e.target.value })}
                />
                <button
                  className="btn-ghost"
                  onClick={() => void detectModels(idx)}
                  disabled={probing[idx]}
                  title="Query <baseUrl>/models and list what the server offers"
                >
                  <RefreshCw size={11} />
                  {probing[idx] ? 'Detecting…' : 'Detect models'}
                </button>
              </div>
              {probeError[idx] && (
                <div className="error-msg" style={{ marginTop: 4 }}>
                  {probeError[idx]}
                </div>
              )}
              {shownIds.length > 0 && (
                <div className="settings-checkbox-list" style={{ maxHeight: 140 }}>
                  {shownIds.map((id) => (
                    <label key={id} className="settings-checkbox-row">
                      <input
                        type="checkbox"
                        checked={modelIds.has(id)}
                        onChange={() => toggleEndpointModel(idx, id)}
                      />
                      <span>{id}</span>
                    </label>
                  ))}
                </div>
              )}

              <button
                type="button"
                className="btn-ghost settings-pi-advanced-toggle"
                onClick={() =>
                  setAdvancedOpen((o) => ({ ...o, [idx]: !o[idx] }))
                }
              >
                {advancedOpen[idx] ? (
                  <ChevronDown size={11} />
                ) : (
                  <ChevronRight size={11} />
                )}
                Advanced (thinking format / headers)
              </button>
              {advancedOpen[idx] && (
                <div className="settings-pi-advanced">
                  <label className="settings-pi-advanced-field">
                    <span>Thinking format</span>
                    <input
                      className="text-input"
                      placeholder="e.g. qwen-chat-template (optional)"
                      value={compatString(ep.compat, 'thinkingFormat')}
                      onChange={(e) =>
                        updateCompat(idx, 'thinkingFormat', e.target.value)
                      }
                    />
                  </label>
                  <label className="settings-checkbox-row">
                    <input
                      type="checkbox"
                      checked={ep.compat?.supportsDeveloperRole !== false}
                      onChange={(e) =>
                        updateCompat(
                          idx,
                          'supportsDeveloperRole',
                          e.target.checked ? undefined : false,
                        )
                      }
                    />
                    <span>Server supports the developer role</span>
                  </label>
                  <div className="settings-pi-advanced-headers">
                    <div className="settings-section-sub">
                      Custom request headers
                    </div>
                    {Object.entries(ep.headers ?? {}).map(([k, v], rowIdx) => (
                      <div key={rowIdx} className="settings-pi-endpoint-head">
                        <input
                          className="text-input"
                          style={{ width: 130 }}
                          placeholder="Header-Name"
                          value={k}
                          onChange={(e) =>
                            updateHeaderKey(idx, rowIdx, e.target.value)
                          }
                        />
                        <input
                          className="text-input"
                          style={{ flex: 1, minWidth: 120 }}
                          placeholder="value"
                          value={v}
                          onChange={(e) =>
                            updateHeaderValue(idx, rowIdx, e.target.value)
                          }
                        />
                        <button
                          className="icon-btn sm"
                          onClick={() => removeHeader(idx, rowIdx)}
                          title="Remove header"
                          aria-label="Remove header"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                    <button
                      className="btn-ghost"
                      onClick={() => addHeader(idx)}
                    >
                      <Plus size={12} />
                      Add header
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <button className="btn-ghost" onClick={addProvider} style={{ marginTop: 8 }}>
          <Plus size={12} />
          Add endpoint
        </button>
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Pi model menu</div>
            <div className="settings-section-sub">
              Which Pi models appear as “Pi — …” options in the harness
              dropdowns (task board, workflow steps, post-merge hook). Includes
              detected models from <code>pi --list-models</code> and the
              endpoints above. Unchecking everything falls back to the default
              menu (your custom-provider models + Pi’s current default).
            </div>
          </div>
        </div>
        {menuPatterns.length === 0 ? (
          <div className="settings-section-sub" style={{ opacity: 0.7 }}>
            No Pi models detected. Install the <code>pi</code> CLI or add an
            endpoint above.
          </div>
        ) : (
          <div className="settings-checkbox-list">
            {menuPatterns.map((pattern) => (
              <label key={pattern} className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={menuSelected.has(pattern)}
                  onChange={() => toggleMenu(pattern)}
                />
                <span>{pattern}</span>
              </label>
            ))}
          </div>
        )}
      </div>
    </>
  );
});
