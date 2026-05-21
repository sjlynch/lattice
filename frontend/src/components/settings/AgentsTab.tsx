import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { fetchGlobalSettings } from '../../api';

type Props = {
  active: boolean;
  open: boolean;
};

export type AgentsTabHandle = {
  // The maxConcurrentAgents value to persist on save, or `undefined` if the
  // user hasn't changed it (so an unrelated save doesn't rewrite the file).
  getMaxConcurrentAgentsPatch: () => number | undefined;
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

  // (Re)load the persisted value each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    setTouched(false);
    fetchGlobalSettings()
      .then((s) => {
        if (cancelled) return;
        setValue(String(s.maxConcurrentAgents));
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
      getMaxConcurrentAgentsPatch: () =>
        touched && valid ? parsed : undefined,
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
