import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { fetchGlobalSettings } from '../../api';

type Props = {
  active: boolean;
  open: boolean;
};

export type AgentsTabHandle = {
  // The maxConcurrentAgents value to persist on save, or `undefined` if the
  // user hasn't changed it (so an unrelated save doesn't rewrite the file).
  // THROWS when the field holds an edited-but-invalid value: the save
  // orchestrator surfaces the message and keeps the dialog open, instead of
  // silently skipping the patch and closing while the field shows an error.
  // (`useSettingsDirty` treats the throw as "dirty".)
  getMaxConcurrentAgentsPatch: () => number | undefined;
};

const MIN_AGENTS = 1;
const MAX_AGENTS = 150;
const INVALID_MESSAGE = `Max concurrent agents must be a whole number between ${MIN_AGENTS} and ${MAX_AGENTS}.`;

// Machine-global settings tab. Unlike the other tabs (per-project
// userSettings) this reads/writes ~/.lattice/globalSettings.json.
export const AgentsTab = forwardRef<AgentsTabHandle, Props>(function AgentsTab(
  { active, open },
  ref,
) {
  const [value, setValue] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [touched, setTouched] = useState(false);
  // The pending load must see edits made after its effect started.
  const touchedRef = useRef(false);

  // (Re)load the persisted value each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setTouched(false);
    touchedRef.current = false;
    fetchGlobalSettings()
      .then((s) => {
        if (cancelled) return;
        if (!touchedRef.current) setValue(String(s.maxConcurrentAgents));
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
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
      getMaxConcurrentAgentsPatch: () => {
        if (!touched) return undefined;
        if (!valid) throw new Error(INVALID_MESSAGE);
        return parsed;
      },
    }),
    [touched, valid, parsed],
  );

  if (!active) return null;

  return (
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
            touchedRef.current = true;
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
  );
});
