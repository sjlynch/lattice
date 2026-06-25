import { SettingsInfo } from './SettingsInfo';

type Props = {
  // All selectable model patterns (saved ∪ draft-endpoint), pre-sorted.
  patterns: string[];
  selected: Set<string>;
  onToggle: (pattern: string) => void;
};

// The "Pi model menu" curation section: a checklist deciding which Pi models
// surface as "Pi — X" rows in the harness dropdowns.
export function PiModelMenu({ patterns, selected, onToggle }: Props) {
  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div>
          <div className="settings-section-title-row">
            <div className="settings-section-title">Pi model menu</div>
            <SettingsInfo label="About the Pi model menu">
              <p>
                Which Pi models appear as “Pi — …” options in the harness
                dropdowns — task board, workflow steps, and the post-merge hook.
              </p>
              <p>
                Includes detected models from <code>pi --list-models</code> and
                the endpoints above. Unchecking everything falls back to the
                default menu (your custom-provider models + Pi’s current
                default).
              </p>
            </SettingsInfo>
          </div>
          <div className="settings-section-sub">
            Which Pi models appear as “Pi — …” options in the harness dropdowns.
          </div>
        </div>
      </div>
      {patterns.length === 0 ? (
        <div className="settings-section-sub" style={{ opacity: 0.7 }}>
          No Pi models detected. Install the <code>pi</code> CLI or add an
          endpoint above.
        </div>
      ) : (
        <div className="settings-checkbox-list">
          {patterns.map((pattern) => (
            <label key={pattern} className="settings-checkbox-row">
              <input
                type="checkbox"
                checked={selected.has(pattern)}
                onChange={() => onToggle(pattern)}
              />
              <span>{pattern}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
