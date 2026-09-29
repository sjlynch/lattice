import { SettingsInfo } from './SettingsInfo';

type Props = {
  // All selectable model patterns (saved ∪ draft-endpoint), pre-sorted.
  patterns: string[];
  selected: Set<string>;
  // Patterns the backend always surfaces because their endpoint auto-discovers
  // its models — rendered fixed rather than as a checkbox that does nothing.
  alwaysShown: Set<string>;
  loaded: boolean;
  loadError: string | null;
  onRetry: () => void;
  onToggle: (pattern: string) => void;
};

// The "Pi model menu" curation section: a checklist deciding which Pi models
// surface as "Pi — X" rows in the harness dropdowns.
export function PiModelMenu({
  patterns, selected, alwaysShown, loaded, loadError, onRetry, onToggle,
}: Props) {
  return (
    <div className="settings-section" aria-busy={!loaded && !loadError}>
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
              <p>
                Models from an endpoint with <b>Auto-discover models</b> on are
                always shown, so a model you load on that server appears without
                coming back here. Turn auto-discover off on the endpoint to
                curate it by hand.
              </p>
            </SettingsInfo>
          </div>
          <div className="settings-section-sub">
            Which Pi models appear as “Pi — …” options in the harness dropdowns.
          </div>
        </div>
      </div>
      {loadError ? (
        <div className="error-msg" role="alert">
          Could not load the saved Pi model menu ({loadError}). Menu choices are
          read-only; saving leaves the saved menu unchanged.{' '}
          <button type="button" className="btn-ghost" onClick={onRetry}>
            Retry loading Pi model menu
          </button>
        </div>
      ) : !loaded && (
        <div className="settings-section-sub" role="status">
          Loading saved Pi model menu… Menu choices are read-only until loading
          finishes.
        </div>
      )}
      {loaded && patterns.length === 0 && (
        <div className="settings-section-sub" style={{ opacity: 0.7 }}>
          No Pi models detected. Install the <code>pi</code> CLI or add an
          endpoint above.
        </div>
      )}
      {patterns.length > 0 && (
        <div className="settings-checkbox-list">
          {patterns.map((pattern) => {
            const fixed = alwaysShown.has(pattern);
            return (
              <label
                key={pattern}
                className="settings-checkbox-row"
                title={
                  fixed
                    ? 'Always shown — this endpoint auto-discovers its models.'
                    : !loaded
                      ? 'Read-only until the saved Pi model menu loads.'
                      : undefined
                }
              >
                <input
                  type="checkbox"
                  checked={fixed || selected.has(pattern)}
                  disabled={fixed || !loaded}
                  onChange={() => onToggle(pattern)}
                />
                <span>{pattern}</span>
                {fixed && (
                  <span className="settings-pi-model-ctx">auto</span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
