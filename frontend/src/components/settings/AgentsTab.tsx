import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { fetchGlobalSettings, getPiModels, type PiModelInfo } from '../../api';

type Props = {
  active: boolean;
  open: boolean;
};

export type AgentsTabHandle = {
  // The maxConcurrentAgents value to persist on save, or `undefined` if the
  // user hasn't changed it (so an unrelated save doesn't rewrite the file).
  getMaxConcurrentAgentsPatch: () => number | undefined;
  // The curated Pi model menu (provider/model patterns) to persist, or
  // `undefined` if untouched. Same clobber-guard contract.
  getPiModelMenuPatch: () => string[] | undefined;
};

const MIN_AGENTS = 1;
const MAX_AGENTS = 150;

// Machine-global settings tab. Unlike the other tabs (per-project
// userSettings) this reads/writes ~/.lattice/globalSettings.json.
export const AgentsTab = forwardRef<AgentsTabHandle, Props>(function AgentsTab(
  { active, open },
  ref,
) {
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState(false);
  // Pi model menu curation: the full model universe + the currently-selected
  // patterns (what shows as "Pi — X" rows in the harness dropdowns).
  const [piModels, setPiModels] = useState<PiModelInfo[]>([]);
  const [piSelected, setPiSelected] = useState<Set<string>>(new Set());
  const [piTouched, setPiTouched] = useState(false);

  // (Re)load the persisted value each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setTouched(false);
    setPiTouched(false);
    fetchGlobalSettings()
      .then((s) => {
        if (cancelled) return;
        setValue(String(s.maxConcurrentAgents));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    // The curation checklist seeds from the *current* effective menu (curated
    // set if any, else the default menu), so it reflects exactly the dropdown.
    getPiModels()
      .then((r) => {
        if (cancelled) return;
        setPiModels(r.models);
        setPiSelected(new Set(r.menu.map((m) => m.pattern)));
      })
      .catch(() => { /* leave empty — pi not installed */ });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const parsed = Number(value);
  const valid =
    Number.isInteger(parsed) &&
    parsed >= MIN_AGENTS &&
    parsed <= MAX_AGENTS;

  useImperativeHandle(
    ref,
    () => ({
      getMaxConcurrentAgentsPatch: () =>
        touched && valid ? parsed : undefined,
      getPiModelMenuPatch: () => (piTouched ? [...piSelected] : undefined),
    }),
    [touched, valid, parsed, piTouched, piSelected],
  );

  if (!active) return null;

  const togglePiModel = (pattern: string) => {
    setPiTouched(true);
    setPiSelected((cur) => {
      const next = new Set(cur);
      if (next.has(pattern)) next.delete(pattern);
      else next.add(pattern);
      return next;
    });
  };

  return (
    <>
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Max concurrent agents</div>
            <div className="settings-section-sub">
              The most agents Lattice runs at once, across every project and
              workflow on this machine. Requested runs above this limit wait in
              a queue and start automatically as slots free up — they are never
              dropped. This is a machine-wide setting, not per-project. Raising
              it uses more CPU and memory; lowering it never stops agents that
              are already running.
            </div>
          </div>
        </div>
        <div className="settings-control-row">
          <label className="settings-control-label" htmlFor="max-concurrent-agents">
            Limit
          </label>
          <input
            id="max-concurrent-agents"
            className="text-input"
            style={{ width: 90 }}
            type="number"
            min={MIN_AGENTS}
            max={MAX_AGENTS}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
          />
        </div>
        {loaded && touched && !valid && (
          <div className="error-msg" style={{ marginTop: 6 }}>
            Enter a whole number between {MIN_AGENTS} and {MAX_AGENTS}.
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <div className="settings-section-title">Pi model menu</div>
            <div className="settings-section-sub">
              Which Pi models appear as “Pi — …” options in the harness
              dropdowns (task board, workflow steps, post-merge hook). Detected
              from <code>pi --list-models</code> — your custom providers
              (e.g. a local vLLM server in <code>~/.pi/agent/models.json</code>)
              plus Pi’s built-in catalog. Machine-wide. Unchecking everything
              falls back to the default menu (your custom-provider models and
              Pi’s current default).
            </div>
          </div>
        </div>
        {piModels.length === 0 ? (
          <div className="settings-section-sub" style={{ opacity: 0.7 }}>
            No Pi models detected. Install the <code>pi</code> CLI (and declare
            any custom providers in <code>~/.pi/agent/models.json</code>) to
            populate this list.
          </div>
        ) : (
          <div className="settings-checkbox-list">
            {piModels.map((m) => (
              <label key={m.pattern} className="settings-checkbox-row">
                <input
                  type="checkbox"
                  checked={piSelected.has(m.pattern)}
                  onChange={() => togglePiModel(m.pattern)}
                />
                <span>
                  {m.pattern}
                  <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>
                    {m.contextWindow ? `· ${m.contextWindow}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </>
  );
});
