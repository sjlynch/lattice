import type { GraphNode, HealthMetrics, HealthSmell } from '../../api';
import type { MetricRowModel } from './healthTooltipMetrics';

const SMELL_LIMIT = 8;

function letterGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function languageLabel(lang: HealthMetrics['language']): string {
  switch (lang) {
    case 'typescript': return 'TypeScript';
    case 'javascript': return 'JavaScript';
    case 'python': return 'Python';
    case 'go': return 'Go';
    case 'rust': return 'Rust';
    case 'java': return 'Java';
    case 'csharp': return 'C#';
    case 'ruby': return 'Ruby';
    case 'fallback': return 'limited analysis';
  }
}

export function HealthTooltipHeader({
  node,
  metrics,
  color,
}: {
  node: GraphNode;
  metrics: HealthMetrics;
  color: string;
}) {
  return (
    <div className="health-tooltip-head">
      <span className="health-tooltip-score" style={{ color }}>
        {metrics.score}
      </span>
      <span className="health-tooltip-grade" style={{ color }}>
        {letterGrade(metrics.score)}
      </span>
      <div className="health-tooltip-titlewrap">
        <div className="health-tooltip-name" title={node.path}>{node.name}</div>
        <div className="health-tooltip-lang">{languageLabel(metrics.language)}</div>
      </div>
    </div>
  );
}

export function MetricGrid({ rows }: { rows: readonly MetricRowModel[] }) {
  return (
    <div className="health-tooltip-grid">
      {rows.map((row) => (
        <MetricRow key={row.label} row={row} />
      ))}
    </div>
  );
}

export function MetricRow({ row }: { row: MetricRowModel }) {
  return (
    <div className="health-tooltip-metric">
      <span className="health-tooltip-metric-label">{row.label}</span>
      <span className="health-tooltip-metric-value">
        {row.value}
        {row.suffix && (
          <span className="health-tooltip-metric-suffix"> {row.suffix}</span>
        )}
      </span>
    </div>
  );
}

export function SmellList({
  smells,
  smellCount,
}: {
  smells: readonly HealthSmell[];
  smellCount: number;
}) {
  if (smells.length === 0) return null;

  return (
    <div className="health-tooltip-smells">
      <div className="health-tooltip-smells-head">
        Smells · {smellCount}
      </div>
      <ul className="health-tooltip-smells-list">
        {smells.slice(0, SMELL_LIMIT).map((s) => (
          <li key={s.id}>
            <span className="health-tooltip-smell-count">{s.count}</span>
            <span className="health-tooltip-smell-label">{s.label}</span>
          </li>
        ))}
        {smells.length > SMELL_LIMIT && (
          <li className="health-tooltip-smell-more">
            +{smells.length - SMELL_LIMIT} more
          </li>
        )}
      </ul>
    </div>
  );
}
