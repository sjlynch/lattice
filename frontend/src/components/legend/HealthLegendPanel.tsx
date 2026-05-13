import { HealthInfoIcon } from './HealthInfoIcon';
import { HEALTH_COMPONENTS } from './healthComponents';

export function HealthLegendPanel() {
  return (
    <div className="legend open health-legend">
      <div className="legend-toggle health-legend-head">
        <span className="health-legend-dot" style={{ background: '#7ed884' }} />
        <span>Code Health</span>
        <span className="health-legend-hint">hold H</span>
      </div>
      <div className="legend-body">
        <div className="health-legend-scale">
          <div className="health-legend-scale-row">
            <span className="health-legend-swatch" style={{ background: '#f57878' }} />
            <span className="health-legend-scale-label">0–39 critical</span>
          </div>
          <div className="health-legend-scale-row">
            <span className="health-legend-swatch" style={{ background: '#f5d76e' }} />
            <span className="health-legend-scale-label">40–69 warn</span>
          </div>
          <div className="health-legend-scale-row">
            <span className="health-legend-swatch" style={{ background: '#7ed884' }} />
            <span className="health-legend-scale-label">70–100 healthy</span>
          </div>
        </div>

        <div className="legend-section-head">
          <span className="legend-section-title">Score components</span>
        </div>
        <div className="health-legend-rows">
          {HEALTH_COMPONENTS.map((c) => (
            <div className="health-legend-row" key={c.label}>
              <div className="health-legend-row-head">
                <span className="health-legend-row-label">{c.label}</span>
                <HealthInfoIcon component={c} />
                <span className="health-legend-row-weight">{c.weight}%</span>
              </div>
              <div className="health-legend-row-note">{c.note}</div>
            </div>
          ))}
        </div>

        <div className="health-legend-foot">
          Hover any file in the graph to see its score and breakdown.
          Files under 30 LOC are scored 100. Languages without a
          dedicated parser get a limited analysis (LOC + universal
          smells only).
        </div>
      </div>
    </div>
  );
}
